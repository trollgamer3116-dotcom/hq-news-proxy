# hq-news-proxy

A tiny full-article reader endpoint for [Aarav's HQ](https://trollgamer3116-dotcom.github.io/aaravhq/).
It fetches a news page server-side, runs Mozilla Readability over it and returns clean JSON,
so the HQ news reader no longer depends on flaky free proxies.

## Endpoints

| Method | Path | Result |
| --- | --- | --- |
| GET | `/health` | `{"ok":true}` |
| GET | `/article?url=<encoded url>` | `{ url, title, byline, siteName, published, excerpt, leadImage, lang, words, content, text }` |

`content` is the cleaned article HTML from Readability (links/images made absolute), and `text` is plain text.
Errors return JSON `{ "error": "..." }` with 400 (bad/blocked URL), 403 (origin), 413 (too large),
415 (not HTML), 422 (no readable article), 429 (rate limited), 502/504 (upstream failure/timeout).

## Guardrails (not an open proxy)

- Only `http`/`https` URLs on ports 80/443, no credentials in the URL.
- DNS is resolved and checked **at connect time** (custom `lookup`), so private, loopback, link-local,
  CGNAT, multicast and metadata addresses are refused, including via redirects (max 5 hops, each re-checked).
- 10 s total timeout, 3 MB max body, HTML/XML content types only.
- CORS only for `https://trollgamer3116-dotcom.github.io` and `http://localhost:*` / `127.0.0.1:*`.
  Browser requests from any other origin get 403.
- In-memory cache (30 min, 200 entries), in-flight de-duplication, rate limit of 30 req/min per IP.

## Run locally

```sh
npm install
npm start            # listens on $PORT or 10000
curl "localhost:10000/article?url=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' https://www.polygon.com/)"
```

Some sandboxes resolve every hostname to fake IPs in `198.18.0.0/15`; set `DEV_ALLOW_198_18=1` only for local testing there.

## Deploy

Runs as a free Render web service (`npm install` / `npm start`, Node 20, region Singapore, auto-deploy from `main`).
Free services sleep after ~15 min idle; the first request after that can take ~30–50 s while it wakes up.
HQ pings `/health` when the News tab opens to wake it in advance.
