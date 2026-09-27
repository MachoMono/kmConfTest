// Embeddings. Default: a deterministic local "hashed TF" embedding (no network, no GPU,
// reproducible in tests). Optionally an OpenAI-compatible /embeddings endpoint configured by KM.
export const DIM = 512;

const STOP = new Set(('a an and are as at be but by for from has have how i if in into is it its of on or our so ' +
  'that the their then there these this to was we what when where which who why will with you your do does can ' +
  'were been being had am did done has is are not no yes all any about also more most other some such than too very just should would could').split(' '));

export function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function terms(text) {
  const words = (String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => !STOP.has(w) && w.length > 1).map(stem);
  return words;
}

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export function localEmbed(text) {
  const v = new Float32Array(DIM);
  const ws = terms(text);
  const tf = new Map();
  for (const w of ws) tf.set(w, (tf.get(w) || 0) + 1);
  for (let i = 0; i + 1 < ws.length; i++) { const bg = ws[i] + ' ' + ws[i + 1]; tf.set(bg, (tf.get(bg) || 0) + 0.5); }
  for (const [t, c] of tf) {
    const h = fnv1a(t);
    const w = (1 + Math.log(c)) * (t.includes(' ') ? 0.6 : 1);
    v[h % DIM] += (h & 0x80000000) ? w : -w;
    // second hash to reduce collisions
    const h2 = fnv1a('#' + t);
    v[h2 % DIM] += (h2 & 0x80000000) ? w * 0.5 : -w * 0.5;
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}

export function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export const toBlob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export const fromBlob = (b) => b ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : null;

/** Build an embedder from settings: {provider:'local'} or {provider:'openai', url, model, apiKey}. */
export function makeEmbedder(settings = {}) {
  if (settings.provider === 'openai' && settings.url) {
    return {
      name: `openai:${settings.model || 'default'}`,
      async embed(texts) {
        const res = await fetch(settings.url.replace(/\/$/, '') + '/embeddings', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}) },
          body: JSON.stringify({ model: settings.model, input: texts }),
        });
        if (!res.ok) throw new Error(`embedding provider returned ${res.status}`);
        const j = await res.json();
        return j.data.map(d => { const v = Float32Array.from(d.embedding); let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map(x => x / n); });
      },
    };
  }
  return { name: 'local', async embed(texts) { return texts.map(localEmbed); } };
}
