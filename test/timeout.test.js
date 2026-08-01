import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildApp } from '../src/app.js';

/**
 * Timeout policy, driven through the route rather than the handlers, because
 * the part worth protecting is what a caller experiences: ask for N ms and hear
 * back in about N ms, whatever the server is doing.
 *
 * Uses the plain engine so these stay fast. The browser path shares the same
 * budget plumbing and is covered in browser.test.js.
 */

const apiKey = 'test-key';
let server;
let baseUrl;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/slow') {
      // Headers, then never finish. Nothing on the client side will resolve.
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.write('<html><body>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>ok</h1></body></html>');
  });
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const scrape = (app, query) =>
  app.inject({
    method: 'GET',
    url: `/scrape?${query}`,
    headers: { 'api-key': apiKey }
  });

describe('timeout policy', () => {
  test('honours the timeout the caller asked for', async () => {
    const app = buildApp({ apiKey, systemMaxTimeout: 300_000 });

    const startedAt = Date.now();
    const res = await scrape(
      app,
      `url=${encodeURIComponent(`${baseUrl}/slow`)}&maxTimeout=2000`
    );
    const elapsed = Date.now() - startedAt;

    assert.equal(res.statusCode, 504);
    assert.match(res.json().error, /Timed out after 2000ms/);
    assert.ok(elapsed >= 1800 && elapsed < 5000, `took ${elapsed}ms, expected ~2000`);

    await app.close();
  });

  test('clamps a request that asks for more than the system allows', async () => {
    const app = buildApp({ apiKey, systemMaxTimeout: 2000 });

    const startedAt = Date.now();
    const res = await scrape(
      app,
      `url=${encodeURIComponent(`${baseUrl}/slow`)}&maxTimeout=600000`
    );
    const elapsed = Date.now() - startedAt;

    assert.equal(res.statusCode, 504);
    // Enforced at the ceiling, not the 10 minutes that were requested.
    assert.match(res.json().error, /Timed out after 2000ms/);
    assert.ok(elapsed < 5000, `took ${elapsed}ms, ceiling should have applied`);

    await app.close();
  });

  test('reports the timeout it actually enforced', async () => {
    const app = buildApp({ apiKey, systemMaxTimeout: 5000 });

    const res = await scrape(
      app,
      `url=${encodeURIComponent(baseUrl)}&maxTimeout=600000`
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().effectiveTimeout, 5000);

    await app.close();
  });

  test('a default above the ceiling is clamped to it', async () => {
    const app = buildApp({
      apiKey,
      defaultMaxTimeout: 900_000,
      systemMaxTimeout: 4000
    });

    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.deepEqual(res.json().timeouts, { default: 4000, max: 4000 });

    await app.close();
  });

  test('a job that runs out of budget while queued fails on time', async () => {
    // One slot, held by a request that will not finish. The second request has
    // to give up on its own schedule rather than waiting for the first, which
    // is the whole point: a per-job timeout starts when a job runs and cannot
    // see time spent waiting.
    const app = buildApp({ apiKey, maxConcurrent: 1, systemMaxTimeout: 300_000 });

    const blocker = scrape(
      app,
      `url=${encodeURIComponent(`${baseUrl}/slow`)}&js=true&maxTimeout=60000`
    ).catch(() => null);

    // Let the blocker take the slot.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const startedAt = Date.now();
    const res = await scrape(
      app,
      `url=${encodeURIComponent(`${baseUrl}/slow`)}&js=true&maxTimeout=2000`
    );
    const elapsed = Date.now() - startedAt;

    assert.equal(res.statusCode, 504);
    assert.match(res.json().error, /waiting in the queue/);
    assert.ok(
      elapsed < 10_000,
      `queued request took ${elapsed}ms; it should not wait for the job ahead`
    );

    await app.close();
    await blocker;
  });
});
