import { launch } from 'cloakbrowser';
import { getRandomProxy } from '../lib/proxies.js';

/**
 * Fetches a URL through a stealth browser, for pages that only exist after
 * JavaScript runs or that block plain HTTP clients.
 *
 * Uses cloakbrowser rather than puppeteer-extra with the stealth plugin. The
 * stealth plugin patches detection surfaces from inside the page, which is a
 * losing position: the patches are themselves detectable, and it has not kept
 * pace with Cloudflare, DataDome or Turnstile. cloakbrowser ships a Chromium
 * with the fingerprint changes applied at source instead, so there is nothing
 * injected at runtime to notice.
 *
 * The Chromium binary is roughly 200MB and downloads on first launch, then
 * caches. Expect the first browser request after a deploy to be slow.
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {number} [options.timeout=55000] - Milliseconds for navigation.
 * @param {number} [options.settleMs=1500] - Quiet period after load, for
 *   client-rendered pages that fill in content after the network goes idle.
 * @returns {Promise<{ html: string, status: number, finalUrl: string }>}
 */
export const fetchWithBrowser = async (
  url,
  { timeout = 55_000, settleMs = 1_500 } = {}
) => {
  const proxy = getRandomProxy();

  const browser = await launch({
    headless: true,
    ...(proxy ? { proxy } : {})
  });

  try {
    const page = await browser.newPage();

    const response = await page.goto(url, {
      timeout,
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
  } finally {
    await browser.close().catch(() => {
      // Nothing useful to do if teardown fails; the request already resolved.
    });
  }
};
