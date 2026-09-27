// Minimal, dependency-free HTTP toolkit: router with params, JSON/raw bodies, cookies,
// security headers, compressed static files with SPA fallback.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)(\*)?/g, (_m, k, star) => { keys.push(k); return star ? '/(.+)' : '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler, opts });
    return this;
  }
  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }
  match(method, pathname) {
    let allowed = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) { allowed = true; continue; }
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return allowed ? { methodNotAllowed: true } : null;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

export function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const isBuf = Buffer.isBuffer(body);
  const isStr = typeof body === 'string';
  const payload = isBuf || isStr ? body : JSON.stringify(body ?? null);
  const h = { ...SECURITY_HEADERS, ...headers };
  if (!isBuf && !isStr && !h['content-type']) h['content-type'] = 'application/json; charset=utf-8';
  if (!h['cache-control']) h['cache-control'] = 'no-store';
  res.writeHead(status, h);
  res.end(res.req && res.req.method === 'HEAD' ? undefined : payload);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.csv': 'text/csv; charset=utf-8', '.yml': 'text/yaml; charset=utf-8',
};
export const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

/** Static file server with in-memory gzip/brotli cache (the bundle is immutable per build). */
export function staticServer(root) {
  const cache = new Map();
  const load = (file) => {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    if (!st.isFile()) return null;
    const hit = cache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit;
    const raw = fs.readFileSync(file);
    const type = mimeOf(file);
    const compressible = /text|javascript|json|svg/.test(type) && raw.length > 1024;
    const entry = { mtime: st.mtimeMs, raw, type, etag: `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`,
      br: compressible ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) : null,
      gz: compressible ? zlib.gzipSync(raw, { level: 6 }) : null };
    cache.set(file, entry);
    return entry;
  };
  return (req, res, pathname) => {
    let rel = decodeURIComponent(pathname);
    let file = path.join(root, rel);
    if (!file.startsWith(root)) return false;
    let e = load(file);
    const isAsset = /\.[a-z0-9]+$/i.test(rel);
    if (!e && !isAsset) e = load(path.join(root, 'index.html')), file = path.join(root, 'index.html');
    if (!e) return false;
    const immutable = /\/assets\//.test(rel);
    const headers = { ...SECURITY_HEADERS, 'content-type': e.type, etag: e.etag,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', vary: 'accept-encoding' };
    if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, headers); res.end(); return true; }
    const ae = req.headers['accept-encoding'] || '';
    let body = e.raw;
    if (e.br && /\bbr\b/.test(ae)) { body = e.br; headers['content-encoding'] = 'br'; }
    else if (e.gz && /\bgzip\b/.test(ae)) { body = e.gz; headers['content-encoding'] = 'gzip'; }
    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
