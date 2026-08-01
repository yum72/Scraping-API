import { getRandomProxy } from '../lib/proxies.js';
import { getRandomUserAgent } from '../lib/userAgent.js';

/**
 * Fetches a URL without a browser.
 *
 * This is the path most requests should take: it is roughly a hundred times
 * cheaper than launching a browser and works on any site that renders its
 * content server-side.
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {number} [options.timeout=30000] - Milliseconds before aborting.
 * @returns {Promise<{ html: string, status: number, finalUrl: string }>}
 */
export const fetchPlain = async (url, { timeout = 30_000 } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  // Node's fetch has no proxy option. A configured proxy needs an agent via
  // undici's ProxyAgent, which is only wired up when a pool exists.
  const proxy = getRandomProxy();
  let dispatcher;
  if (proxy) {
    const { ProxyAgent } = await import('undici');
    dispatcher = new ProxyAgent(proxy);
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': getRandomUserAgent(),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      redirect: 'follow',
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {})
    });

    const html = await response.text();

    if (response.status >= 400) {
      const error = new Error(`Upstream responded ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return { html, status: response.status, finalUrl: response.url };
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error(`Timed out after ${timeout}ms`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
