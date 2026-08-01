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
| `MAX_CONCURRENT_BROWSERS` | 15 | Browser jobs allowed at once. Requests past it queue rather than fail. |
| `PROXIES` | empty | Comma or newline separated. `http://user:pass@host:port`, or `host:port`. Empty means connect directly. |

Proxies live in the environment, not in a committed file. A random one is picked
per request when the pool is non-empty.

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
npm test
```

Covers auth, parameter validation and the URL scheme guard. They run through
`app.inject()` with no port bound and make no network calls, so they are fast and
work offline. The engines themselves are not unit tested, since what they do is
talk to the internet.

## Concurrency

Only the browser path is limited. Plain fetches are cheap enough that the event
loop is the constraint, but each browser job is a Chromium process and a few
hundred MB, so they go through a queue.

Requests past the limit wait rather than fail. An earlier version returned 503
once a counter passed 15, which turned load into errors and leaked the counter
whenever a job threw.

## History

Rewritten in 2026. It was originally a 2020 Koa app on `request` and Puppeteer
2.0.0, with the API key hardcoded as `1234`. The current version is Fastify on
native `fetch` and cloakbrowser, with the key required from the environment.

## License

MIT
