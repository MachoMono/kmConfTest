// Client foundation: API client, router, live events, small helpers.
import { signal } from './signal.js';

export class ApiError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

export async function api(path, { method = 'GET', body, raw, headers = {}, text = false } = {}) {
  const init = { method, credentials: 'same-origin', headers: { 'x-gitwiki-csrf': '1', ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  const res = await fetch('/api/v1' + path, init);
  if (text && res.ok) return res.text();
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) session.value = { ...session.value, user: null };
    throw new ApiError(res.status, (data && data.error) || res.statusText, data);
  }
  return data;
}
api.get = (p) => api(p);
api.post = (p, body) => api(p, { method: 'POST', body: body ?? {} });
api.put = (p, body) => api(p, { method: 'PUT', body: body ?? {} });
api.del = (p) => api(p, { method: 'DELETE' });

// ---- global state ---------------------------------------------------------------------------
export const session = signal({ user: null, loaded: false });
export const config = signal({ siteName: 'GitWiki', flags: {} });
export const toasts = signal([]);
export const route = signal({ path: location.pathname, query: Object.fromEntries(new URLSearchParams(location.search)), hash: location.hash });
export const unread = signal(0);

let toastId = 0;
export function toast(message, kind = 'info', ms = 4000) {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, message, kind }];
  setTimeout(() => { toasts.value = toasts.value.filter(t => t.id !== id); }, ms);
}
export function errorToast(e) { toast(e && e.message ? e.message : String(e), 'error', 6000); }

// ---- router ---------------------------------------------------------------------------------
export function navigate(to, { replace = false } = {}) {
  if (to === location.pathname + location.search + location.hash) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', to);
  syncRoute();
  if (!to.includes('#')) window.scrollTo(0, 0);
}
function syncRoute() {
  route.value = { path: location.pathname, query: Object.fromEntries(new URLSearchParams(location.search)), hash: location.hash };
}
window.addEventListener('popstate', syncRoute);
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
  const href = a.getAttribute('href');
  if (!href || !href.startsWith('/') || href.startsWith('//') || href.startsWith('/api/')) return;
  if (a.closest('.ProseMirror')) { e.preventDefault(); return; }
  e.preventDefault();
  navigate(href);
});

export function matchRoute(pattern, path) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)(\*)?/g, (_m, k, s) => { keys.push(k); return s ? '(.+)' : '([^/]+)'; }) + '/?$');
  const m = re.exec(path);
  if (!m) return null;
  const params = {};
  keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
  return params;
}

// ---- live events (SSE) -------------------------------------------------------------------------
const listeners = new Map();
let es = null;
export function onEvent(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type).delete(fn);
}
export function connectEvents() {
  if (es) es.close();
  es = new EventSource('/api/v1/events');
  for (const type of ['notification', 'page', 'presence', 'comment', 'sync']) {
    es.addEventListener(type, (ev) => {
      let data; try { data = JSON.parse(ev.data); } catch { return; }
      for (const fn of listeners.get(type) || []) fn(data);
    });
  }
}

// ---- helpers -------------------------------------------------------------------------------------
export function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
export const fmtDate = (iso) => iso ? new Date(iso).toLocaleString() : '';
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export function initials(name) { return String(name || '?').split(/[\s._-]+/).map(s => s[0]).join('').slice(0, 2).toUpperCase(); }
export function colorFor(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 45%)`; }
export const TYPE_ICONS = { Document: '📄', Person: '👤', Team: '👥', System: '🧩', Project: '🎯', Process: '🔁', Policy: '📜', Concept: '💡', Decision: '⚖️', Meeting: '🗓️', HowTo: '🛠️' };
export const typeIcon = (t) => TYPE_ICONS[t] || '📄';
export function download(url) { const a = document.createElement('a'); a.href = url; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }
