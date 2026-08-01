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
 * @param {number} [options.queueTimeout=180000] - Ceiling on a queued browser
 *   job, counted from when it starts running.
 * @param {Object} [options.logger] - Fastify logger option.
 * @returns {import('fastify').FastifyInstance}
 */
export const buildApp = ({
  apiKey,
  maxConcurrent = 15,
  queueTimeout = 180_000,
  logger = false
} = {}) => {
  if (!apiKey) {
    throw new Error('apiKey is required');
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
  const queue = new PQueue({
    concurrency: maxConcurrent,
    timeout: queueTimeout,
    throwOnTimeout: true
  });

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
          timeout: { type: 'integer', minimum: 1000, maximum: 120_000 }
        }
      }
    }
  }, async (request, reply) => {
    const { url, js, timeout } = request.query;

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reply.code(400).send({ error: 'url is not a valid URL' });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return reply.code(400).send({ error: 'url must be http or https' });
    }

    const options = timeout ? { timeout } : {};

    try {
      const result = js
        ? await queue.add(() => fetchWithBrowser(url, options), { throwOnTimeout: true })
        : await fetchPlain(url, options);

      return { ...result, engine: js ? 'browser' : 'fetch' };
    } catch (error) {
      // A timeout is ours, not the target's, so it maps to 504 rather than 502.
      const status = error.status === 504 || error.name === 'TimeoutError'
        ? 504
        : error.status && error.status >= 400
          ? 502
          : 500;
      request.log?.error({ err: error, url }, 'scrape failed');
      return reply.code(status).send({
        // Playwright errors carry ANSI colour codes and a multi-line call log,
        // which is useful in a terminal and noise in a JSON response body.
        error: String(error.message)
          .replace(/\u001b\[[0-9;]*m/g, '')
          .split('\nCall log:')[0]
          .trim(),
        upstreamStatus: error.status >= 400 && error.status !== 504 ? error.status : null
      });
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
