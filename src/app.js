import Fastify from 'fastify';
import pLimit from 'p-limit';
import { fetchPlain } from './handlers/plain.js';
import { fetchWithBrowser } from './handlers/browser.js';
import { proxyCount } from './lib/proxies.js';

/**
 * Builds the Fastify app.
 *
 * Exported separately from the listen call so tests can drive it with
 * `app.inject()` without binding a port.
 *
 * @param {Object} [options]
 * @param {string} options.apiKey - Required. Requests must present it as api-key.
 * @param {number} [options.maxConcurrent=15] - Browser jobs allowed at once.
 * @param {Object} [options.logger] - Fastify logger option.
 * @returns {import('fastify').FastifyInstance}
 */
export const buildApp = ({ apiKey, maxConcurrent = 15, logger = false } = {}) => {
  if (!apiKey) {
    throw new Error('apiKey is required');
  }

  const app = Fastify({ logger });

  // Only the browser path is limited. Plain fetches are cheap enough that the
  // event loop is the only meaningful constraint, but each browser job costs a
  // Chromium process and a few hundred MB, so they queue.
  //
  // The previous version incremented a counter and rejected past the limit,
  // which both leaked on throw and turned load into errors. p-limit queues
  // instead, so callers wait rather than fail.
  const limit = pLimit(maxConcurrent);

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
    proxies: proxyCount(),
    browserSlots: { max: maxConcurrent, queued: limit.pendingCount, active: limit.activeCount }
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
        ? await limit(() => fetchWithBrowser(url, options))
        : await fetchPlain(url, options);

      return { ...result, engine: js ? 'browser' : 'fetch' };
    } catch (error) {
      const status = error.status && error.status >= 400 ? 502 : 500;
      request.log?.error({ err: error, url }, 'scrape failed');
      return reply.code(status).send({
        error: error.message,
        upstreamStatus: error.status ?? null
      });
    }
  });

  return app;
};
