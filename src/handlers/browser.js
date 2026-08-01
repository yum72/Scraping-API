import { chromium } from 'playwright-core';
import { buildLaunchOptions } from 'cloakbrowser';
import { getRandomProxy } from '../lib/proxies.js';

/**
 * Every browser this process has started and not yet torn down.
 *
 * Needed for two reasons: a hung job has to be killable from outside the
 * promise that is stuck, and shutdown has to be able to reap whatever is still
 * running rather than leaving orphaned Chromium processes behind.
 */
const liveSessions = new Set();

/** Milliseconds to wait for a graceful close before resorting to SIGKILL. */
const CLOSE_GRACE_MS = 5_000;

/**
 * Resolves after ms, or rejects with a tagged error. Used to bound operations
 * that have no timeout of their own.
 */
const rejectAfter = (ms, message) =>
  new Promise((_, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(message);
      error.isTimeout = true;
      reject(error);
    }, ms);
    // Do not hold the event loop open just for this timer.
    timer.unref?.();
  });

/**
 * Starts a browser and returns a handle that can always be terminated.
 *
 * Uses chromium.launchServer rather than cloakbrowser's launch() helper
 * specifically to get at the child process. Playwright's Browser object has no
 * .process(), so a browser that stops responding cannot be killed through it,
 * which is how these end up accumulating. launchServer hands back a real PID.
 *
 * @param {Object} [options]
 * @param {string|null} [options.proxy]
 * @param {number} [options.launchTimeout=60000]
 * @returns {Promise<{ browser: import('playwright-core').Browser, dispose: () => Promise<void>, kill: () => void }>}
 */
const startSession = async ({ proxy, launchTimeout = 60_000 } = {}) => {
  const launchOptions = await buildLaunchOptions({
    headless: true,
    ...(proxy ? { proxy } : {})
  });

  // The first launch after a deploy downloads a ~200MB Chromium, so this is
  // bounded generously rather than tightly.
  const server = await Promise.race([
    chromium.launchServer(launchOptions),
    rejectAfter(launchTimeout, `Browser failed to start within ${launchTimeout}ms`)
  ]);

  const child = server.process();
  const session = { server, child, browser: null, disposed: false };

  /** SIGKILL the browser. Safe to call repeatedly and at any point. */
  const kill = () => {
    try {
      if (child?.pid && !child.killed) process.kill(child.pid, 'SIGKILL');
    } catch {
      // Already gone. Nothing to do.
    }
  };

  /**
   * Tear down, and guarantee the process is gone by the time this resolves.
   * Graceful first so pages get a chance to flush, then SIGKILL on a timer,
   * because server.close() can itself hang on a wedged browser and awaiting it
   * unbounded is what leaves the process alive.
   */
  const dispose = async () => {
    if (session.disposed) return;
    session.disposed = true;

    try {
      await Promise.race([
        (async () => {
          await session.browser?.close().catch(() => {});
          await server.close().catch(() => {});
        })(),
        rejectAfter(CLOSE_GRACE_MS, 'close timed out')
      ]);
    } catch {
      kill();
    } finally {
      // Belt and braces: even after a clean close, confirm the process is not
      // still around before dropping the only reference to it.
      kill();
      liveSessions.delete(session);
    }
  };

  session.kill = kill;
  session.dispose = dispose;

  try {
    session.browser = await Promise.race([
      chromium.connect(server.wsEndpoint()),
      rejectAfter(launchTimeout, 'Could not connect to the browser')
    ]);
  } catch (error) {
    kill();
    await server.close().catch(() => {});
    throw error;
  }

  liveSessions.add(session);
  return session;
};

/**
 * Fetches a URL through a stealth browser, for pages that only exist after
 * JavaScript runs or that block plain HTTP clients.
 *
 * Uses cloakbrowser rather than puppeteer-extra with the stealth plugin. The
 * stealth plugin patches detection surfaces from inside the page, which is a
 * losing position: the patches are themselves detectable, and it has not kept
 * pace with Cloudflare, DataDome or Turnstile. cloakbrowser ships a Chromium
 * with the fingerprint changes applied at source, so there is nothing injected
 * at runtime to notice.
 *
 * The Chromium binary is roughly 200MB and downloads on first launch, then
 * caches. Expect the first browser request after a deploy to be slow.
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {number} [options.deadlineAt] - Absolute epoch ms by which this must
 *   be done. Set once when the request arrives, so it also covers time spent
 *   waiting in the queue.
 * @param {number} [options.budget] - Size of that budget, for error messages.
 * @param {number} [options.timeout] - Navigation timeout. Clamped to whatever
 *   is left of the budget; defaults to the whole remainder.
 * @param {number} [options.settleMs=1500] - Quiet period after load, for
 *   client-rendered pages that fill in content after the network goes idle.
 * @returns {Promise<{ html: string, status: number, finalUrl: string }>}
 */
export const fetchWithBrowser = async (
  url,
  { deadlineAt, budget, timeout, settleMs = 1_500 } = {}
) => {
  const deadline = deadlineAt ?? Date.now() + 120_000;
  const remainingAtStart = deadline - Date.now();

  // Already out of time before doing anything, which happens when a job has
  // been sitting in the queue. Fail here rather than spending 40 seconds
  // launching a browser for a caller who has stopped waiting.
  if (remainingAtStart <= 0) {
    const error = new Error(
      `Timed out after ${budget ?? 'the configured'}ms, waiting in the queue`
    );
    error.status = 504;
    throw error;
  }

  const proxy = getRandomProxy();
  const session = await startSession({ proxy, launchTimeout: remainingAtStart });

  const work = async () => {
    const page = await session.browser.newPage();

    // Navigation never gets more than the budget has left, so a generous
    // per-request timeout cannot outlive the deadline the caller asked for.
    const remaining = deadline - Date.now();
    const navigationTimeout = Math.max(1_000, Math.min(timeout ?? remaining, remaining));

    const response = await page.goto(url, {
      timeout: navigationTimeout,
      waitUntil: 'domcontentloaded'
    });

    // Give client-rendered pages a moment to populate. networkidle is not used
    // as the wait condition because pages with polling or open sockets never
    // reach it and the navigation times out on sites that are otherwise fine.
    await page.waitForTimeout(settleMs);

    const status = response?.status() ?? 0;

    if (status >= 400) {
      const error = new Error(`Upstream responded ${status}`);
      error.status = status;
      throw error;
    }

    return {
      html: await page.content(),
      status,
      finalUrl: page.url()
    };
  };

  try {
    return await Promise.race([
      work(),
      rejectAfter(
        Math.max(1, deadline - Date.now()),
        `Timed out after ${budget ?? deadline - Date.now()}ms`
      ).catch((error) => {
        // Racing alone does not stop the work; the pending page calls would sit
        // there holding a Chromium process open. Killing it makes them reject.
        session.kill();
        throw error;
      })
    ]);
  } catch (error) {
    if (error.isTimeout) error.status = 504;
    throw error;
  } finally {
    await session.dispose();
  }
};

/** How many browsers are currently running. Exposed for /health. */
export const liveBrowserCount = () => liveSessions.size;

/**
 * Tears down every running browser. Called on shutdown so a restart does not
 * leave Chromium processes behind holding onto memory.
 *
 * @returns {Promise<number>} How many sessions were closed.
 */
export const closeAllBrowsers = async () => {
  const sessions = [...liveSessions];
  await Promise.allSettled(sessions.map((session) => session.dispose()));
  return sessions.length;
};
