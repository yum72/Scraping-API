import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';

import {
  fetchWithBrowser,
  liveBrowserCount,
  closeAllBrowsers
} from '../src/handlers/browser.js';

/**
 * These launch a real Chromium, so they are slower than the rest of the suite.
 * They exist because the failure they guard against is a leak, and a leak is
 * exactly the kind of thing that never shows up until production memory climbs.
 */

/** Counts cloakbrowser Chromium processes belonging to this machine. */
const chromeProcesses = () => {
  try {
    const out = execSync('pgrep -fc "cloakbrowser/chromium.*chrome" || true', {
      encoding: 'utf8'
    });
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
};

let server;
let baseUrl;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/hang') {
      // Headers sent, body never finished: navigation never completes.
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.write('<html><body><h1>hanging</h1>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>ok</h1></body></html>');
  });

  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await closeAllBrowsers();
  await new Promise((resolve) => server.close(resolve));
});

describe('browser lifecycle', { concurrency: 1 }, () => {
  test('releases the browser after a successful fetch', async () => {
    const before = chromeProcesses();

    const result = await fetchWithBrowser(`${baseUrl}/`, { timeout: 30_000 });

    assert.equal(result.status, 200);
    assert.match(result.html, /<h1>ok<\/h1>/);
    assert.equal(liveBrowserCount(), 0, 'session should be released');

    // Chromium teardown is not instantaneous, so allow it a moment.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.ok(
      chromeProcesses() <= before,
      `leaked processes: before ${before}, after ${chromeProcesses()}`
    );
  });

  test('releases the browser when navigation times out', async () => {
    const before = chromeProcesses();

    await assert.rejects(
      () => fetchWithBrowser(`${baseUrl}/hang`, { timeout: 3000 }),
      /Timeout|exceeded/
    );

    assert.equal(liveBrowserCount(), 0, 'session should be released on timeout');

    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.ok(
      chromeProcesses() <= before,
      `leaked processes: before ${before}, after ${chromeProcesses()}`
    );
  });

  test('kills the browser when the hard deadline passes', async () => {
    const before = chromeProcesses();

    // hardTimeout below the navigation timeout, so the deadline is what fires.
    // This is the backstop for a page that gets past goto and then wedges,
    // where nothing else would ever give up.
    const error = await fetchWithBrowser(`${baseUrl}/hang`, {
      timeout: 60_000,
      hardTimeout: 2000
    }).then(
      () => null,
      (err) => err
    );

    assert.ok(error, 'should reject');
    assert.match(error.message, /exceeded 2000ms/);
    assert.equal(error.status, 504, 'a deadline is our timeout, not the target');
    assert.equal(liveBrowserCount(), 0);

    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.ok(
      chromeProcesses() <= before,
      `leaked processes: before ${before}, after ${chromeProcesses()}`
    );
  });

  test('closeAllBrowsers reaps sessions that are still running', async () => {
    // Start a job and deliberately do not await it.
    const pending = fetchWithBrowser(`${baseUrl}/hang`, { timeout: 60_000 }).catch(
      () => 'rejected'
    );

    // Wait for the browser to actually come up.
    const deadline = Date.now() + 60_000;
    while (liveBrowserCount() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(liveBrowserCount(), 1, 'a session should be running');

    const closed = await closeAllBrowsers();
    assert.equal(closed, 1);
    assert.equal(liveBrowserCount(), 0, 'shutdown should leave nothing running');

    assert.equal(await pending, 'rejected', 'the in-flight job should fail, not hang');
  });
});
