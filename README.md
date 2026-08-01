# Scraping-API

An HTTP API that fetches a page and gives you the HTML. Each request goes through
one of two engines: a plain HTTP fetch, or a stealth browser for pages that only
exist after JavaScript runs.

**Status:** working, rewritten 2026 · Node 20+

The point is that you pick per request. A plain fetch is roughly a hundred times
cheaper than a browser, and most pages do not need one, so paying browser costs
for every URL is waste. Sites that do need a browser tend to also be the ones
running bot detection, which is why the browser path is not stock Chromium.

## Quick start

```bash
npm install
cp .env.example .env          # then set API_KEY
API_KEY=$(openssl rand -hex 24) npm start
```

```bash
# plain fetch
curl -H "api-key: $API_KEY" \
  "http://localhost:3000/scrape?url=https://example.com"

# through the browser
curl -H "api-key: $API_KEY" \
  "http://localhost:3000/scrape?url=https://example.com&js=true"
```

Both return the same shape:

```json
{
  "html": "<!doctype html>...",
  "status": 200,
  "finalUrl": "https://example.com/",
  "engine": "fetch"
}
```

## API

### `GET /scrape`

Authenticated with an `api-key` header.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | The page to fetch. Must be http or https. |
| `js` | boolean | `false` | Use the browser engine instead of plain fetch. |
| `timeout` | integer | 30000 fetch, 55000 browser | Milliseconds, 1000 to 120000. |

Responses:

| Status | Meaning |
|---|---|
| 200 | Page fetched. Body has `html`, `status`, `finalUrl`, `engine`. |
| 400 | `url` missing, unparseable, or not http/https. |
| 401 | `api-key` missing or wrong. |
| 502 | The target site answered with an error. `upstreamStatus` has its code. |
| 504 | Our timeout, not the target's. The job was killed. |
| 500 | The request failed before a response, for example DNS or connection refused. |

### `GET /health`

Open, no key. Reports proxy count and browser queue depth, so it works as both a
container healthcheck and a load signal.

```json
{ "status": "ok", "proxies": 0, "browserSlots": { "max": 15, "queued": 0, "active": 2 } }
```

## Configuration

Environment variables, all listed in `.env.example`:

| Variable | Default | Meaning |
|---|---|---|
| `API_KEY` | none | Required. The server exits rather than start without it. |
| `PORT` | 3000 | |
| `HOST` | 0.0.0.0 | |
| `MAX_CONCURRENT_BROWSERS` | 15 | Browser jobs running at once. See Queue. |
| `BROWSER_JOB_TIMEOUT_MS` | 180000 | Ceiling on one browser job. See Queue. |
| `PROXIES_FILE` | empty | Path to a proxy list. See Proxies. |
| `PROXIES` | empty | Inline proxy list. See Proxies. |

## Proxies

Drop in a list and go. Nothing else to configure.

```bash
PROXIES_FILE=./proxies.txt API_KEY=$API_KEY npm start
```

```
# proxies.txt — one per line
203.0.113.10:8080
user:pass@203.0.113.11:8080
http://203.0.113.12:3128
socks5://203.0.113.13:1080

# commented out for now, kept for later
# 203.0.113.99:8080
```

A bare `host:port` is assumed to be http. Credentials can be inline. Blank lines
and `#` comments are skipped, so entries can be disabled without deleting them.
For one or two proxies the inline form is fine:

```bash
PROXIES="203.0.113.10:8080,203.0.113.11:8080"
```

Both apply to both engines: plain fetches go through an undici `ProxyAgent`, and
the browser gets the proxy at launch.

Selection is round-robin, not random. Random distributes unevenly over a short
run, which on a small pool means one proxy takes several requests in a row and
gets rate limited while another sits idle. One `ProxyAgent` is kept per proxy and
reused, so connections stay pooled instead of being rebuilt per request.

`/health` reports what loaded, with credentials stripped, which is the quick way
to confirm a list was picked up:

```json
{ "count": 4, "source": "PROXIES_FILE", "hosts": ["http://203.0.113.10:8080", "..."] }
```

A `PROXIES_FILE` that cannot be read is a startup error rather than a warning.
Silently continuing would send every request from the server's own IP, which is
the thing the pool existed to prevent.

## Why cloakbrowser

The browser engine uses [cloakbrowser](https://github.com/CloakHQ/cloakbrowser)
rather than Puppeteer with `puppeteer-extra-plugin-stealth`.

Stealth plugins patch detection surfaces from inside the page after Chromium has
already started. That is a losing position twice over: the patches are themselves
detectable, since a `navigator.webdriver` that has been redefined does not look
like one that was never there, and the plugin has not kept up with Cloudflare,
DataDome or Turnstile. cloakbrowser ships a Chromium with the fingerprint changes
applied at source, so there is nothing injected at runtime to catch.

Two practical consequences:

- The Chromium binary is about 200MB and downloads on first launch, then caches.
  First browser request after a fresh deploy takes around 40 seconds; subsequent
  ones take about 2. The Dockerfile warms it at build time so this does not land
  on a user.
- Chromium needs more shared memory than Docker's default 64MB. `docker-compose.yml`
  sets `shm_size: 1gb`. Without it the browser crashes on any substantial page.

## Docker

```bash
API_KEY=$(openssl rand -hex 24) docker compose up --build
```

## Tests

```bash
npm test           # fast, no network, no browser
npm run test:browser   # launches a real Chromium, ~20s
npm run test:all
```

`npm test` covers auth, parameter validation and the URL scheme guard. It runs
through `app.inject()` with no port bound and makes no network calls, so it is
fast and works offline.

`npm run test:browser` is separate because it starts real browsers. It is the
suite that guards against process leaks, so it is worth running before a deploy
even though it is slower.

## Queue

Only the browser path is queued. Plain fetches are cheap enough that the event
loop is the constraint, but each browser job is a Chromium process and a few
hundred MB.

The queue is [p-queue](https://github.com/sindresorhus/p-queue), with
`concurrency` from `MAX_CONCURRENT_BROWSERS` and a per-job `timeout` from
`BROWSER_JOB_TIMEOUT_MS`.

| Behaviour | |
|---|---|
| Past the concurrency limit | Requests wait in the queue. They are not rejected. |
| Job exceeds its timeout | The browser is killed and the request gets 504. |
| Server shuts down | The queue is paused and cleared, and running browsers are reaped. |

The 2020 version incremented a counter and returned 503 once it passed 15, which
turned load into errors and leaked the count whenever a job threw. p-queue also
reports `size` and `pending`, which is what makes the numbers on `/health` real
rather than an estimate.

`/health` is the thing to watch:

```json
{
  "browser": { "max": 15, "running": 4, "queued": 2, "processes": 4 }
}
```

`processes` counts live Chromium sessions. It should track `running`. A
`processes` count that stays above `running` means browsers are being leaked, and
that is the number to alert on.

## Browser lifecycle

Browsers that hang and are never cleaned up are the way a scraping service ends
up slowly eating memory, so termination is guaranteed rather than hoped for.

Chromium is started through `chromium.launchServer` rather than cloakbrowser's
`launch()` helper. That is deliberate: Playwright's `Browser` object has no
`.process()`, so a browser that stops responding cannot be killed through it.
`launchServer` returns a real PID, which means SIGKILL is always available.

Every job is bounded twice. `page.goto` has its own navigation timeout, and the
whole job additionally runs against a deadline, because a page can get past
navigation and then wedge in `content()` where nothing else would ever give up.
When the deadline passes the process is killed, which is what makes the pending
page calls reject instead of sitting there holding Chromium open.

Teardown is bounded too. `close()` is tried first so pages can flush, but it is
raced against a five-second timer and followed by SIGKILL either way, because
`close()` can itself hang on a wedged browser and awaiting it unbounded is
precisely what leaves the process alive.

Every running browser is tracked, so `SIGTERM` and `SIGINT` reap whatever is
in flight rather than orphaning it. Shutdown has its own 20-second backstop that
exits regardless.

`npm run test:browser` covers all of it against a real Chromium: normal
completion, navigation timeout, the hard deadline, and shutdown with a job still
running. Each asserts that the process count does not grow.

## History

Rewritten in 2026. It was originally a 2020 Koa app on `request` and Puppeteer
2.0.0, with the API key hardcoded as `1234`. The current version is Fastify on
undici and cloakbrowser, with the key required from the environment.

## License

MIT
