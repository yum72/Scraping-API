/**
 * Proxy pool. Reads a newline- or comma-separated list from the PROXIES
 * environment variable, so proxies never end up committed to the repo.
 *
 * Format per entry: http://user:pass@host:port, or host:port for an
 * unauthenticated proxy.
 */

const parseProxies = (raw) =>
  (raw || '')
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.includes('://') ? entry : `http://${entry}`));

const proxies = parseProxies(process.env.PROXIES);

/**
 * Returns a random proxy URL, or null when no pool is configured.
 * Callers treat null as "connect directly".
 *
 * @returns {string | null}
 */
export const getRandomProxy = () => {
  if (proxies.length === 0) return null;
  return proxies[Math.floor(Math.random() * proxies.length)];
};

/** @returns {number} How many proxies are configured. */
export const proxyCount = () => proxies.length;
