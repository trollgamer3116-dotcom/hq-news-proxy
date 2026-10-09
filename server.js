'use strict';
// hq-news-proxy: GET /article?url=... -> readable JSON. GET /health -> ok.
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');
const { parseHTML } = require('linkedom');
const { Readability } = require('@mozilla/readability');

const PORT = process.env.PORT || 10000;
const TIMEOUT_MS = 10000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CACHE_TTL = 30 * 60 * 1000;
const CACHE_MAX = 200;
const RATE_WINDOW = 60 * 1000;
const RATE_MAX = 30; // requests per IP per minute
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const ALLOWED_ORIGINS = new Set(['https://trollgamer3116-dotcom.github.io']);
// Local dev only: some sandboxes resolve DNS to fake IPs in 198.18.0.0/15. Never set in production.
const ALLOW_198_18 = process.env.DEV_ALLOW_198_18 === '1';
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// ---------- private address blocking ----------
function ipv4Private(ip) {
  const p = ip.split('.').map(Number);
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (!ALLOW_198_18 && a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function isPrivate(ip) {
  if (net.isIPv4(ip)) return ipv4Private(ip);
  const s = ip.toLowerCase();
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return ipv4Private(m[1]);
  return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') ||
    s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') ||
    s.startsWith('ff') || s.startsWith('64:ff9b') || s.startsWith('2001:db8');
}
// Validating lookup: the IP that is checked is the IP that is connected to (no DNS rebinding gap).
function safeLookup(host, opts, cb) {
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter(a => !isPrivate(a.address));
    if (!ok.length || ok.length !== addrs.length) return cb(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
    if (opts && opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}
function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && !['80', '443', ''].includes(u.port)) return null;
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(h) && isPrivate(h)) return null;
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(h)) return null;
  return u;
}

// ---------- fetch ----------
function fetchPage(url, hops = 0, deadline = Date.now() + TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const u = checkUrl(url);
    if (!u) return reject(Object.assign(new Error('url not allowed'), { status: 400 }));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, {
      lookup: safeLookup,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      timeout: Math.max(1000, deadline - Date.now()),
    }, res => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (hops >= MAX_REDIRECTS) return reject(Object.assign(new Error('too many redirects'), { status: 502 }));
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch { return reject(Object.assign(new Error('bad redirect'), { status: 502 })); }
        return fetchPage(next, hops + 1, deadline).then(resolve, reject);
      }
      if (code !== 200) { res.resume(); return reject(Object.assign(new Error('upstream ' + code), { status: 502, upstream: code })); }
      const ct = String(res.headers['content-type'] || '');
      if (ct && !/html|xml/i.test(ct)) { res.resume(); return reject(Object.assign(new Error('not html'), { status: 415 })); }
      if (Number(res.headers['content-length']) > MAX_BYTES) { res.destroy(); return reject(Object.assign(new Error('too large'), { status: 413 })); }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = []; let size = 0;
      stream.on('data', c => {
        size += c.length;
        if (size > MAX_BYTES) { res.destroy(); stream.destroy(); reject(Object.assign(new Error('too large'), { status: 413 })); return; }
        chunks.push(c);
      });
      stream.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), finalUrl: u.toString() }));
      stream.on('error', e => reject(e));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { status: 504 })));
    req.on('error', e => reject(e.code === 'EBLOCKED' ? Object.assign(e, { status: 400 }) : Object.assign(e, { status: e.status || 502 })));
  });
}

// ---------- extract ----------
function meta(doc, ...names) {
  for (const n of names) {
    const el = doc.querySelector(`meta[property="${n}"],meta[name="${n}"]`);
    const v = el && el.getAttribute('content');
    if (v) return v.trim();
  }
  return '';
}
function absolutize(doc, base) {
  for (const [sel, attr] of [['a[href]', 'href'], ['img[src]', 'src'], ['source[srcset]', 'srcset'], ['img[srcset]', 'srcset']]) {
    for (const el of doc.querySelectorAll(sel)) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      if (attr === 'srcset') {
        el.setAttribute(attr, v.split(',').map(p => { const [x, w] = p.trim().split(/\s+/); try { return new URL(x, base).toString() + (w ? ' ' + w : ''); } catch { return ''; } }).filter(Boolean).join(', '));
      } else { try { el.setAttribute(attr, new URL(v, base).toString()); } catch {} }
    }
  }
  // lazy images
  for (const img of doc.querySelectorAll('img')) {
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
    if (lazy && (!img.getAttribute('src') || /^data:/.test(img.getAttribute('src')))) { try { img.setAttribute('src', new URL(lazy, base).toString()); } catch {} }
  }
}
function extract(html, url) {
  const { document } = parseHTML(html);
  const leadImage = meta(document, 'og:image', 'twitter:image', 'og:image:url');
  const siteName = meta(document, 'og:site_name', 'application-name');
  const published = meta(document, 'article:published_time', 'parsely-pub-date', 'date');
  absolutize(document, url);
  const art = new Readability(document, { charThreshold: 400 }).parse();
  if (!art || !art.content) return null;
  const text = (art.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  let img = leadImage;
  try { if (img) img = new URL(img, url).toString(); } catch { img = ''; }
  return {
    url,
    title: art.title || meta(document, 'og:title') || '',
    byline: art.byline || meta(document, 'author') || '',
    siteName: art.siteName || siteName || '',
    published: art.publishedTime || published || '',
    excerpt: art.excerpt || '',
    leadImage: img,
    lang: art.lang || '',
    words: (text.match(/\S+/g) || []).length,
    content: art.content,
    text,
  };
}

// ---------- cache + rate limit ----------
const cache = new Map();
function cacheGet(k) { const e = cache.get(k); if (!e) return null; if (Date.now() - e.at > CACHE_TTL) { cache.delete(k); return null; } return e.v; }
function cachePut(k, v) { cache.set(k, { v, at: Date.now() }); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW);
  arr.push(now); hits.set(ip, arr);
  return arr.length > RATE_MAX;
}
setInterval(() => { const now = Date.now(); for (const [ip, a] of hits) if (!a.some(t => now - t < RATE_WINDOW)) hits.delete(ip); }, RATE_WINDOW).unref();
const inflight = new Map();

// ---------- server ----------
function send(res, status, body, origin) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' };
  if (origin) { h['Access-Control-Allow-Origin'] = origin; h['Access-Control-Allow-Methods'] = 'GET, OPTIONS'; h['Access-Control-Max-Age'] = '86400'; }
  if (status === 200 && body && body.content) h['Cache-Control'] = 'public, max-age=1800';
  res.writeHead(status, h);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
const server = http.createServer(async (req, res) => {
  const o = req.headers.origin || '';
  const origin = ALLOWED_ORIGINS.has(o) || LOCAL_ORIGIN.test(o) ? o : '';
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(origin ? 204 : 403, origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' } : {}); return res.end(); }
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' }, origin);
  if (u.pathname === '/health' || u.pathname === '/') return send(res, 200, { ok: true }, origin);
  if (u.pathname !== '/article') return send(res, 404, { error: 'not found' }, origin);
  // Browsers from other sites are refused; non-browser callers (no Origin) are allowed but rate-limited.
  if (o && !origin) return send(res, 403, { error: 'origin not allowed' }, '');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) return send(res, 429, { error: 'slow down' }, origin);
  const target = checkUrl(u.searchParams.get('url') || '');
  if (!target) return send(res, 400, { error: 'invalid url' }, origin);
  const key = target.toString();
  const hit = cacheGet(key);
  if (hit) return send(res, 200, Object.assign({ cached: true }, hit), origin);
  try {
    let p = inflight.get(key);
    if (!p) { p = fetchPage(key).then(({ html, finalUrl }) => extract(html, finalUrl)); inflight.set(key, p); p.finally(() => inflight.delete(key)).catch(() => {}); }
    const art = await p;
    if (!art || art.words < 80) return send(res, 422, { error: 'no readable article' }, origin);
    cachePut(key, art);
    send(res, 200, art, origin);
  } catch (e) {
    send(res, e.status || 502, { error: e.message || 'fetch failed', upstream: e.upstream }, origin);
  }
});
server.headersTimeout = 15000;
server.requestTimeout = 20000;
server.listen(PORT, () => console.log('hq-news-proxy listening on ' + PORT));
