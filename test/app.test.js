import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

const apiKey = 'test-key';
const build = () => buildApp({ apiKey });

describe('auth', () => {
  test('rejects a request with no api-key', async () => {
    const app = build();
    const res = await app.inject({ method: 'GET', url: '/scrape?url=https://example.com' });
    assert.equal(res.statusCode, 401);
    assert.match(res.json().error, /api-key header required/);
    await app.close();
  });

  test('rejects a wrong api-key', async () => {
    const app = build();
    const res = await app.inject({
      method: 'GET',
      url: '/scrape?url=https://example.com',
      headers: { 'api-key': 'wrong' }
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test('leaves /health open', async () => {
    const app = build();
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'ok');
    await app.close();
  });
});

describe('validation', () => {
  test('requires a url', async () => {
    const app = build();
    const res = await app.inject({
      method: 'GET',
      url: '/scrape',
      headers: { 'api-key': apiKey }
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  test('rejects a url that does not parse', async () => {
    const app = build();
    const res = await app.inject({
      method: 'GET',
      url: '/scrape?url=not-a-url',
      headers: { 'api-key': apiKey }
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /not a valid URL/);
    await app.close();
  });

  test('rejects non-http schemes', async () => {
    const app = build();
    const res = await app.inject({
      method: 'GET',
      url: `/scrape?url=${encodeURIComponent('file:///etc/passwd')}`,
      headers: { 'api-key': apiKey }
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /http or https/);
    await app.close();
  });
});

describe('construction', () => {
  test('refuses to build without an api key', () => {
    assert.throws(() => buildApp({}), /apiKey is required/);
  });
});
