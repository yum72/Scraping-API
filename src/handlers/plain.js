import { fetch, ProxyAgent } from 'undici';
import { getRandomProxy } from '../lib/proxies.js';
import { getRandomUserAgent } from '../lib/userAgent.js';

/**
 * One ProxyAgent per proxy, reused across requests.
 *
 * A fresh agent per request opens a fresh connection pool per request, which
 * throws away keep-alive and leaks sockets under load.
 */
const agents = new Map();

const agentFor = (proxy) => {
  if (!agents.has(proxy)) {
    agents.set(proxy, new ProxyAgent(proxy));
  }
  return agents.get(proxy);
};

/**
 * Fetches a URL without a browser.
 *
 * This is the path most requests should take: it is roughly a hundred times
 * cheaper than launching a browser and works on any site that renders its
 * content server-side.
 *
 * Uses undici's fetch rather than the global one. Node's built-in fetch bundles
 * its own copy of undici, and handing it a dispatcher built by the standalone
 * package fails with "invalid onRequestStart method". Taking both fetch and
 * ProxyAgent from the same package keeps them in step.
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {number} [options.deadlineAt] - Absolute epoch ms by which this must
 *   be done. The same budget the browser path uses, so both engines honour one
 *   number rather than each having its own idea of a timeout.
 * @param {number} [options.budget] - Size of that budget, for error messages.
 * @param {number} [options.timeout] - Per-request timeout, clamped to whatever
 *   is left of the budget.
 * @returns {Promise<{ html: string, status: number, finalUrl: string }>}
 */
export const fetchPlain = async (url, { deadlineAt, budget, timeout } = {}) => {
  const deadline = deadlineAt ?? Date.now() + 30_000;
  const remaining = deadline - Date.now();

  if (remaining <= 0) {
    const error = new Error(`Timed out after ${budget ?? 'the configured'}ms`);
    error.status = 504;
    throw error;
  }

  const effective = Math.max(1_000, Math.min(timeout ?? remaining, remaining));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effective);

  // Node's fetch has no proxy option, so a proxy has to arrive as a dispatcher.
  const proxy = getRandomProxy();

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': getRandomUserAgent(),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      redirect: 'follow',
      signal: controller.signal,
      ...(proxy ? { dispatcher: agentFor(proxy) } : {})
    });

    const html = await response.text();

    if (response.status >= 400) {
      const error = new Error(`Upstream responded ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return { html, status: response.status, finalUrl: response.url };
  } catch (error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      const timeoutError = new Error(`Timed out after ${budget ?? effective}ms`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    // undici wraps connection failures; the cause carries the useful detail.
    if (error.cause?.code) {
      const wrapped = new Error(`${error.message} (${error.cause.code})`);
      wrapped.status = error.status;
      throw wrapped;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

/** Closes pooled proxy agents. Called on shutdown. */
export const closeProxyAgents = async () => {
  await Promise.allSettled([...agents.values()].map((agent) => agent.close()));
  agents.clear();
};
