// OpenID Connect single sign-on (authorization code + PKCE). Verifies RS256/ES256 ID tokens
// against the provider's JWKS, provisions users just-in-time and maps a groups claim to groups.
import crypto from 'node:crypto';
import { randomToken, httpError } from './auth.js';
import { now } from './db.js';

const b64url = (b) => Buffer.from(b).toString('base64url');

export class Oidc {
  constructor(app) { this.app = app; this._disco = null; this._jwks = null; }
  get conf() { return this.app.settings.get('oidc', null); }
  enabled() { const c = this.conf; return !!(c && c.issuer && c.clientId); }

  async discovery() {
    const c = this.conf;
    if (this._disco && this._disco.issuer === c.issuer.replace(/\/$/, '')) return this._disco;
    const r = await fetch(c.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration');
    if (!r.ok) throw httpError(502, 'OIDC discovery failed');
    this._disco = await r.json();
    return this._disco;
  }

  async authorizeUrl(redirectUri, returnTo = '/') {
    const c = this.conf;
    const d = await this.discovery();
    const state = randomToken(16), nonce = randomToken(16), verifier = randomToken(32);
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    this.app.db.run('INSERT INTO oidc_states (state, verifier, nonce, created_at, return_to) VALUES (?,?,?,?,?)', state, verifier, nonce, now(), returnTo);
    const u = new URL(d.authorization_endpoint);
    u.search = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: redirectUri, scope: c.scope || 'openid profile email groups',
      state, nonce, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    return u.toString();
  }

  async callback({ code, state }, redirectUri) {
    const c = this.conf;
    const st = this.app.db.get('SELECT * FROM oidc_states WHERE state = ?', state || '');
    if (!st) throw httpError(400, 'Invalid or expired login state');
    this.app.db.run('DELETE FROM oidc_states WHERE state = ?', state);
    if (Date.now() - Date.parse(st.created_at) > 10 * 60_000) throw httpError(400, 'Login state expired');
    const d = await this.discovery();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: c.clientId, code_verifier: st.verifier });
    if (c.clientSecret) body.set('client_secret', c.clientSecret);
    const r = await fetch(d.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!r.ok) throw httpError(401, 'OIDC token exchange failed');
    const tok = await r.json();
    const claims = await this.verify(tok.id_token, st.nonce);
    return { user: this.provision(claims), returnTo: st.return_to || '/' };
  }

  async verify(jwt, nonce) {
    const c = this.conf;
    const [h, p, s] = String(jwt || '').split('.');
    if (!s) throw httpError(401, 'Malformed ID token');
    const header = JSON.parse(Buffer.from(h, 'base64url'));
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    if (!['RS256', 'ES256'].includes(header.alg)) throw httpError(401, 'Unsupported ID token algorithm');
    const d = await this.discovery();
    if (!this._jwks || !this._jwks.keys.some(k => k.kid === header.kid)) {
      const jr = await fetch(d.jwks_uri);
      this._jwks = await jr.json();
    }
    const jwk = this._jwks.keys.find(k => !header.kid || k.kid === header.kid);
    if (!jwk) throw httpError(401, 'Signing key not found');
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const ok = crypto.verify(header.alg === 'RS256' ? 'RSA-SHA256' : 'SHA256', Buffer.from(`${h}.${p}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(s, 'base64url'));
    if (!ok) throw httpError(401, 'Invalid ID token signature');
    const t = Math.floor(Date.now() / 1000);
    if (claims.iss !== d.issuer) throw httpError(401, 'ID token issuer mismatch');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(c.clientId)) throw httpError(401, 'ID token audience mismatch');
    if (claims.exp && claims.exp < t - 60) throw httpError(401, 'ID token expired');
    if (nonce && claims.nonce !== nonce) throw httpError(401, 'ID token nonce mismatch');
    return claims;
  }

  provision(claims) {
    const c = this.conf;
    const users = this.app.users;
    let u = this.app.db.get('SELECT * FROM users WHERE oidc_sub = ?', claims.sub);
    const username = String(claims.preferred_username || (claims.email || '').split('@')[0] || 'user-' + claims.sub).toLowerCase().replace(/[^a-z0-9._-]+/g, '.').replace(/^[.-]+|[.-]+$/g, '').slice(0, 60);
    if (!u) {
      u = users.byUsername(username);
      if (u) users.update(u.id, { oidc_sub: claims.sub });
      else u = users.create({ username, email: claims.email, name: claims.name || username, role: c.defaultRole || 'user', oidc_sub: claims.sub });
    } else users.update(u.id, { email: claims.email || u.email, name: claims.name || u.name });
    u = users.byId(u.id);
    if (!u.active) throw httpError(403, 'Account disabled');
    const groups = claims[c.groupsClaim || 'groups'];
    if (Array.isArray(groups)) {
      for (const g of groups) users.addToGroup(String(g).slice(0, 64), u.id);
      const adminGroups = (c.adminGroups || []).map(s => s.toLowerCase());
      const kmGroups = (c.kmGroups || []).map(s => s.toLowerCase());
      const lg = groups.map(g => String(g).toLowerCase());
      if (lg.some(g => adminGroups.includes(g))) users.update(u.id, { role: 'admin' });
      else if (lg.some(g => kmGroups.includes(g)) && u.role !== 'admin') users.update(u.id, { role: 'km_admin' });
    }
    this.app.audit(u, 'auth.sso', u.username, { sub: claims.sub });
    return users.byId(u.id);
  }
}
