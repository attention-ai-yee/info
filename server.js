/*
 * visitor-logger — a minimal visitor-logging website.
 *
 * Zero external dependencies (Node.js >= 18). Captures server-side request
 * data (IP, headers, proxy headers, Client Hints, optional GeoIP) together
 * with a client-side payload POSTed from the page, and appends one JSON
 * object per visit to data/visits.jsonl (size-capped, rotated).
 *
 * Env:
 *   PORT          listen port            (default 3000)
 *   HOST          bind address           (default 0.0.0.0 — set 127.0.0.1 for local-only)
 *   VIEW_TOKEN    secret to read /logs   (default '' = endpoint disabled)
 *   TRUST_PROXY   trusted proxy hops     (default 0; >0 to honour XFF/cf-* for rate-limiting & logged IP)
 *   MAX_LOG_BYTES per-file log cap       (default 50MB; rotates to visits.jsonl.1)
 *
 * Optional GeoIP: `npm install maxmind` and place GeoLite2-City.mmdb /
 * GeoLite2-ASN.mmdb in data/ to populate the `geo` field. Absent => null.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const VIEW_TOKEN = process.env.VIEW_TOKEN || '';
const TRUST_PROXY = Number(process.env.TRUST_PROXY) || 0;
const MAX_LOG_BYTES = Number(process.env.MAX_LOG_BYTES) || (50 * 1024 * 1024);

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const LOG_FILE = path.join(DATA_DIR, 'visits.jsonl');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 64 * 1024;
const RL_WINDOW_MS = 60_000;
const RL_MAX = 60;
const RL_CAP = 50000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const ACCEPT_CH = 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model, Sec-CH-UA-Wow64';

// ---- per-IP rate limit (in-memory sliding window, size-capped) ----
const rl = new Map(); // key -> { count, resetAt }
function rateLimited(key) {
  const now = Date.now();
  let e = rl.get(key);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + RL_WINDOW_MS }; rl.set(key, e); }
  e.count++;
  if (rl.size > RL_CAP) {
    for (const [k, v] of rl) if (now > v.resetAt) rl.delete(k);
    if (rl.size > RL_CAP) rl.clear();
  }
  return e.count > RL_MAX;
}
const rlGc = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rl) if (now > v.resetAt) rl.delete(k);
}, 60_000);
rlGc.unref();

// ---- serialized, rotating appends ----
let writeChain = Promise.resolve();
function appendLine(line) {
  writeChain = writeChain.then(() => new Promise((resolve) => {
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    } catch (e) { /* file may not exist yet */ }
    fs.appendFile(LOG_FILE, line + '\n', 'utf8', (err) => {
      if (err) console.error('[visitor-logger] append error:', err.message);
      resolve(!err);
    });
  }));
  return writeChain;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
ensureDataDir();

function stripV4Prefix(addr) {
  return (addr || '').replace(/^::ffff:/, '');
}

// Best-effort client IP. Honours proxy headers only when deployed behind a
// trusted proxy (TRUST_PROXY>0). The rate-limiter uses the unspoofable TCP
// peer address unless TRUST_PROXY is set.
function pickIp(req) {
  const h = req.headers;
  const socket = stripV4Prefix(req.socket.remoteAddress);
  if (!TRUST_PROXY) return socket || null;
  const xff = stripV4Prefix((h['x-forwarded-for'] || '').split(',')[0].trim());
  const candidates = [
    stripV4Prefix(h['cf-connecting-ip']),
    stripV4Prefix(h['true-client-ip']),
    stripV4Prefix(h['x-real-ip']),
    xff,
    socket,
  ];
  return candidates.find(Boolean) || socket || null;
}

function rlKey(req) {
  return TRUST_PROXY ? pickIp(req) : stripV4Prefix(req.socket.remoteAddress);
}

// ---- optional GeoLite2 lookup (graceful no-op if maxmind/DBs absent) ----
let _geo = undefined; // undefined=not-init, null=unavailable, object={city,asn}
function getGeo() {
  if (_geo !== undefined) return _geo;
  try {
    const maxmind = require('maxmind');
    const cityPath = path.join(DATA_DIR, 'GeoLite2-City.mmdb');
    const asnPath = path.join(DATA_DIR, 'GeoLite2-ASN.mmdb');
    _geo = {
      city: fs.existsSync(cityPath) ? maxmind.openSync(cityPath) : null,
      asn: fs.existsSync(asnPath) ? maxmind.openSync(asnPath) : null,
    };
    if (!_geo.city && !_geo.asn) _geo = null;
  } catch (e) { _geo = null; }
  return _geo;
}
function geoLookup(ip) {
  if (!ip) return null;
  const g = getGeo(); if (!g) return null;
  try {
    const c = g.city ? g.city.get(ip) : null;
    const a = g.asn ? g.asn.get(ip) : null;
    return {
      country: (c && c.country && c.country.isoCode) || null,
      region: (c && c.subdivisions && c.subdivisions[0] && c.subdivisions[0].isoCode) || null,
      city: (c && c.city && c.city.names && c.city.names.en) || null,
      lat: (c && c.location && c.location.latitude) || null,
      lon: (c && c.location && c.location.longitude) || null,
      asn: (a && a.autonomous_system_number) || null,
      org: (a && a.autonomous_system_organization) || null,
    };
  } catch (e) { return null; }
}

function serverPayload(req) {
  const h = req.headers;
  const url = req.url || '';
  const ip = pickIp(req);
  return {
    id: crypto.randomUUID(),
    received_at: new Date().toISOString(),
    received_at_ms: Date.now(),
    ip,
    geo: geoLookup(ip),
    socket_address: stripV4Prefix(req.socket.remoteAddress) || null,
    method: req.method,
    url,
    path: url.split('?')[0],
    query: url.split('?')[1] || '',
    http_version: req.httpVersion,
    cf_connecting_ip: h['cf-connecting-ip'] || null,
    true_client_ip: h['true-client-ip'] || null,
    x_real_ip: h['x-real-ip'] || null,
    x_forwarded_for: h['x-forwarded-for'] || null,
    cf_ipcountry: h['cf-ipcountry'] || null,
    cf_ipregion: h['cf-ipregion'] || null,
    cf_ipcity: h['cf-ipcity'] || null,
    host: h['host'] || null,
    sec_ch_ua: h['sec-ch-ua'] || null,
    sec_ch_ua_full_version_list: h['sec-ch-ua-full-version-list'] || null,
    sec_ch_ua_platform: h['sec-ch-ua-platform'] || null,
    sec_ch_ua_platform_version: h['sec-ch-ua-platform-version'] || null,
    sec_ch_ua_arch: h['sec-ch-ua-arch'] || null,
    sec_ch_ua_bitness: h['sec-ch-ua-bitness'] || null,
    sec_ch_ua_model: h['sec-ch-ua-model'] || null,
    sec_ch_ua_wow64: h['sec-ch-ua-wow64'] || null,
    sec_ch_ua_mobile: h['sec-ch-ua-mobile'] || null,
    headers: h,
  };
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        done = true;
        const e = new Error('body_too_large');
        e.code = 'BODY_TOO_LARGE';
        req.destroy();
        reject(e);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

function send(res, status, body, headers = {}) {
  let payload, contentType;
  if (Buffer.isBuffer(body)) {
    payload = body;
    contentType = headers['Content-Type'] || 'application/octet-stream';
  } else if (body !== null && typeof body === 'object') {
    payload = JSON.stringify(body);
    contentType = 'application/json; charset=utf-8';
  } else {
    payload = String(body == null ? '' : body);
    contentType = headers['Content-Type'] || 'text/plain; charset=utf-8';
  }
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

function timingSafeTokenEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function extractToken(req, url) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return url.searchParams.get('token') || '';
}

// Bounded tail read to avoid loading unbounded logs into memory.
function readTailJsonLines(filePath, maxBytes, limit) {
  if (!fs.existsSync(filePath)) return [];
  const size = fs.statSync(filePath).size;
  let buf;
  if (size <= maxBytes) {
    buf = fs.readFileSync(filePath);
  } else {
    const fd = fs.openSync(filePath, 'r');
    try {
      buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
    } finally { fs.closeSync(fd); }
  }
  let text = buf.toString('utf8');
  if (size > maxBytes) {
    const nl = text.indexOf('\n');
    if (nl >= 0) text = text.slice(nl + 1);
  }
  const lines = text.split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return { _raw: l }; } });
}

async function handleLog(req, res) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) return send(res, 415, { ok: false, error: 'unsupported_media_type' });
  if (rateLimited(rlKey(req))) return send(res, 429, { ok: false, error: 'rate_limited' });
  let text;
  try { text = await readBody(req, MAX_BODY); }
  catch (e) {
    if (e && e.code === 'BODY_TOO_LARGE') return send(res, 413, { ok: false, error: 'body_too_large' });
    console.error('[visitor-logger] readBody error:', e);
    return send(res, 400, { ok: false, error: 'bad_request' });
  }
  let client = null;
  if (text) {
    try { client = JSON.parse(text); }
    catch { client = { _raw: text.slice(0, 4096) }; }
  }
  const record = { ...serverPayload(req), client };
  const ok = await appendLine(JSON.stringify(record));
  if (!ok) return send(res, 500, { ok: false, error: 'write_failed' });
  return send(res, 200, { ok: true, id: record.id });
}

function handleLogs(req, res, url) {
  if (!VIEW_TOKEN) { res.writeHead(404); res.end(); return; } // generic 404, no body
  if (rateLimited(rlKey(req) + ':logs')) return send(res, 429, { ok: false, error: 'rate_limited' });
  const token = extractToken(req, url);
  if (!timingSafeTokenEqual(token, VIEW_TOKEN)) return send(res, 403, { ok: false, error: 'forbidden' });
  const raw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(raw) && raw >= 0 ? Math.min(Math.trunc(raw), 1000) : 100;
  const entries = readTailJsonLines(LOG_FILE, 512 * 1024, limit);
  return send(res, 200, { count: entries.length, entries });
}

function handleStatic(res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, '.' + rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, 'forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.html') headers['Accept-CH'] = ACCEPT_CH;
    return send(res, 200, buf, headers);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  try {
    if (req.method === 'POST' && url.pathname === '/log') return await handleLog(req, res);
    if (req.method === 'GET' && url.pathname === '/logs') return handleLogs(req, res, url);
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET') return handleStatic(res, url);
    return send(res, 405, { ok: false, error: 'method_not_allowed' });
  } catch (e) {
    console.error('[visitor-logger] handler error:', e);
    return send(res, 500, { ok: false, error: 'server_error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[visitor-logger] listening on http://${HOST}:${PORT}`);
  console.log(`[visitor-logger] writing logs to ${LOG_FILE} (cap ${MAX_LOG_BYTES} bytes)`);
  console.log(`[visitor-logger] TRUST_PROXY=${TRUST_PROXY} (rate-limit keyed on ${TRUST_PROXY ? 'proxy IP' : 'TCP peer address'})`);
  console.log(`[visitor-logger] GeoIP: ${getGeo() ? 'enabled' : 'disabled (install maxmind + GeoLite2-*.mmdb in data/ to enable)'}`);
  if (VIEW_TOKEN) console.log('[visitor-logger] view logs: Authorization: Bearer ***  or  /logs?token=***');
  else console.log('[visitor-logger] /logs disabled (set VIEW_TOKEN to enable)');
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`[visitor-logger] reachable on http://${net.address}:${PORT} (${name})`);
        }
      }
    }
  } catch {}
});
