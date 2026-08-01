import fs from 'node:fs';

/**
 * Proxy pool.
 *
 * Two ways to supply one, because a list of any size belongs in a file rather
 * than an environment variable:
 *
 *   PROXIES      inline, comma or newline separated
 *   PROXIES_FILE path to a file, one proxy per line
 *
 * Accepted per entry, with or without credentials:
 *
 *   http://user:pass@host:port
 *   host:port                     assumed http
 *   user:pass@host:port           assumed http
 *   socks5://host:1080
 *
 * Blank lines and lines starting with # are ignored, so a list can be
 * commented and entries disabled without deleting them.
 */

const parseProxies = (raw) =>
  (raw || '')
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.startsWith('#'))
    .map((entry) => (entry.includes('://') ? entry : `http://${entry}`));

const readProxyFile = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    // Fail loudly. Silently running with no proxies when a list was configured
    // means every request goes out from the server's own IP, which is exactly
    // what the pool existed to prevent.
    throw new Error(`PROXIES_FILE could not be read (${filePath}): ${error.message}`);
  }
};

const loadProxies = () => {
  const fromFile = process.env.PROXIES_FILE
    ? parseProxies(readProxyFile(process.env.PROXIES_FILE))
    : [];
  const fromEnv = parseProxies(process.env.PROXIES);

  // Deduplicate, since the same proxy appearing twice would just skew the
  // rotation towards it.
  return [...new Set([...fromFile, ...fromEnv])];
};

const proxies = loadProxies();

// Round-robin rather than random. Random picks unevenly over a short run, which
// on a small pool means one proxy takes several requests in a row and gets rate
// limited while another sits idle.
let cursor = 0;

/**
 * Returns the next proxy URL, or null when no pool is configured.
 * Callers treat null as "connect directly".
 *
 * @returns {string | null}
 */
export const getRandomProxy = () => {
  if (proxies.length === 0) return null;
  const proxy = proxies[cursor % proxies.length];
  cursor += 1;
  return proxy;
};

/** @returns {number} How many proxies are configured. */
export const proxyCount = () => proxies.length;

/**
 * Pool state for /health, with credentials stripped. Useful for confirming a
 * list actually loaded without printing passwords into logs.
 *
 * @returns {{ count: number, source: string, hosts: string[] }}
 */
export const proxySummary = () => ({
  count: proxies.length,
  source: process.env.PROXIES_FILE
    ? 'PROXIES_FILE'
    : proxies.length > 0
      ? 'PROXIES'
      : 'none',
  hosts: proxies.slice(0, 5).map((proxy) => {
    try {
      const { protocol, hostname, port } = new URL(proxy);
      return `${protocol}//${hostname}${port ? `:${port}` : ''}`;
    } catch {
      return 'unparseable';
    }
  })
});
