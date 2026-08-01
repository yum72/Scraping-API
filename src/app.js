import Fastify from 'fastify';
import PQueue from 'p-queue';
import { fetchPlain, closeProxyAgents } from './handlers/plain.js';
import { fetchWithBrowser, liveBrowserCount, closeAllBrowsers } from './handlers/browser.js';
import { proxyCount, proxySummary } from './lib/proxies.js';

/**
 * Builds the Fastify app.
 *
 * Exported separately from the listen call so tests can drive it with
 * `app.inject()` without binding a port.
 *
 * @param {Object} [options]
 * @param {string} options.apiKey - Required. Requests must present it as api-key.
 * @param {number} [options.maxConcurrent=15] - Browser jobs allowed at once.
 * @param {number} [options.defaultMaxTimeout=120000] - Budget applied when a
 *   request does not ask for one.
 * @param {number} [options.systemMaxTimeout=300000] - Hard ceiling. A request
 *   asking for more than this is clamped down to it.
 * @param {Object} [options.logger] - Fastify logger option.
 * @returns {import('fastify').FastifyInstance}
 */
export const buildApp = ({
  apiKey,
  maxConcurrent = 15,
  defaultMaxTimeout: requestedDefault = 120_000,
  systemMaxTimeout = 300_000,
  logger = false
} = {}) => {
  let defaultMaxTimeout = requestedDefault;
  if (!apiKey) {
    throw new Error('apiKey is required');
  }

  // A default above the ceiling is a misconfiguration that would otherwise sit
  // there looking deliberate on /health. Clamp it and say so.
  if (defaultMaxTimeout > systemMaxTimeout) {
    defaultMaxTimeout = systemMaxTimeout;
  }

  const app = Fastify({ logger });

  // Only the browser path is queued. Plain fetches are cheap enough that the
  // event loop is the only meaningful constraint, but each browser job costs a
  // Chromium process and a few hundred MB.
  //
  // p-queue rather than a bare concurrency limiter: it carries a per-job
  // timeout, and it reports size and pending, which is what makes the queue
  // depth on /health real rather than a guess. The 2020 version incremented a
  // counter and returned 503 past 15, which turned load into errors and leaked
  // the count whenever a job threw.
  // No timeout option here on purpose. p-queue counts its timeout from when a
  // job starts running, so it cannot see time spent waiting in the queue; a
  // request could sit for five minutes, run for one, and satisfy a "one minute"
  // limit while the caller waited six. The deadline set per request below spans
  // both, and a job that is already past it is dropped before a browser starts.
  const queue = new PQueue({ concurrency: maxConcurrent });

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;

    const presented = request.headers['api-key'];
    if (!presented) {
      return reply.code(401).send({ error: 'api-key header required' });
    }
    if (presented !== apiKey) {
      return reply.code(401).send({ error: 'Invalid api-key' });
    }
  });

  app.get('/health', async () => ({
    status: 'ok',
    timeouts: { default: defaultMaxTimeout, max: systemMaxTimeout },
    proxies: proxySummary(),
    browser: {
      max: maxConcurrent,
      running: queue.pending,
      queued: queue.size,
      // Live Chromium processes. This should track "running"; a number that
      // stays above it is the signal that browsers are being leaked.
      processes: liveBrowserCount()
    }
  }));

  app.get('/scrape', {
    schema: {
      querystring: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string' },
          js: { type: 'boolean', default: false },
          timeout: { type: 'integer', minimum: 1000, maximum: 300_000 },
          maxTimeout: { type: 'integer', minimum: 1000, maximum: 600_000 }
        }
      }
    }
  }, async (request, reply) => {
    const { url, js, timeout, maxTimeout } = request.query;

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reply.code(400).send({ error: 'url is not a valid URL' });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return reply.code(400).send({ error: 'url must be http or https' });
    }

    // One budget for the whole request, measured from the moment it arrived.
    // It covers queue wait, browser launch, navigation and content extraction,
    // so it is the number a caller can actually reason about: ask for 60000 and
    // you hear back within about a minute either way.
    //
    // Clamped rather than rejected, so a caller asking for an hour gets the
    // ceiling and a clear effectiveTimeout in the reply instead of a 400 they
    // have to go and read the docs about.
    const budget = Math.min(maxTimeout ?? defaultMaxTimeout, systemMaxTimeout);
    const deadlineAt = Date.now() + budget;

    const options = { deadlineAt, budget, ...(timeout ? { timeout } : {}) };

    // The budget has to be enforced while a job is still queued, not only once
    // it starts. Otherwise a caller asking for 8 seconds sits behind a 60
    // second job and hears back at 55 seconds with an "8 second timeout", which
    // is worse than useless. p-queue drops a pending task when its signal
    // aborts, so the reply lands on time whatever the queue depth.
    const controller = new AbortController();
    const budgetTimer = setTimeout(() => controller.abort(), budget);

    // Aborting rejects queue.add() whether the job had started or not, so track
    // it: "timed out waiting in the queue" and "timed out while running" send a
    // caller to very different places.
    let started = false;

    try {
      const result = js
        ? await queue.add(
            () => {
              started = true;
              return fetchWithBrowser(url, options);
            },
            { signal: controller.signal }
          )
        : await fetchPlain(url, options);

      return {
        ...result,
        engine: js ? 'browser' : 'fetch',
        // What was actually enforced, which differs from maxTimeout when the
        // request asked for more than the server allows.
        effectiveTimeout: budget
      };
    } catch (error) {
      // An aborted job is one that ran out of budget while queued.
      const timedOut =
        error.status === 504 ||
        error.name === 'TimeoutError' ||
        error.name === 'AbortError';

      // A timeout is ours, not the target's, so it maps to 504 rather than 502.
      const status = timedOut
        ? 504
        : error.status && error.status >= 400
          ? 502
          : 500;
      request.log?.error({ err: error, url }, 'scrape failed');
      return reply.code(status).send({
        // Playwright errors carry ANSI colour codes and a multi-line call log,
        // which is useful in a terminal and noise in a JSON response body.
        error: timedOut && error.name === 'AbortError'
          ? started
            ? `Timed out after ${budget}ms`
            : `Timed out after ${budget}ms, waiting in the queue`
          : String(error.message)
              .replace(/\u001b\[[0-9;]*m/g, '')
              .split('\nCall log:')[0]
              .trim(),
        upstreamStatus: error.status >= 400 && error.status !== 504 ? error.status : null
      });
    } finally {
      clearTimeout(budgetTimer);
    }
  });

  // Reap any browser still running when the server closes, so a restart or a
  // crashed deploy does not leave Chromium processes holding memory.
  app.addHook('onClose', async () => {
    queue.pause();
    queue.clear();
    const closed = await closeAllBrowsers();
    if (closed > 0) app.log?.info(`closed ${closed} browser(s) on shutdown`);
    await closeProxyAgents();
  });

  return app;
};
