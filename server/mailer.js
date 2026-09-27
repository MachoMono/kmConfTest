// Delivers queued notification emails (email_outbox) over SMTP when KM configures it.
// Without SMTP settings, mail stays queued and visible in Admin › System.
import nodemailer from 'nodemailer';
import { now } from './db.js';

export class Mailer {
  constructor(app) { this.app = app; this._timer = null; this._busy = false; }

  transport() {
    const s = this.app.settings.get('smtp', null);
    if (!s || !s.host) return null;
    const key = JSON.stringify(s);
    if (this._key !== key) {
      this._key = key;
      this._t = nodemailer.createTransport({
        host: s.host, port: Number(s.port || 587), secure: !!s.secure,
        auth: s.user ? { user: s.user, pass: s.password } : undefined,
        tls: s.allowSelfSigned ? { rejectUnauthorized: false } : undefined,
        connectionTimeout: 10000,
      });
    }
    return this._t;
  }

  /** Send up to `limit` queued messages. Returns {sent, failed}. */
  async flush(limit = 50) {
    if (this._busy) return { sent: 0, failed: 0, busy: true };
    const t = this.transport();
    if (!t) return { sent: 0, failed: 0, configured: false };
    this._busy = true;
    const from = this.app.settings.get('smtp', {}).from || `GitWiki <no-reply@${new URL(this.app.cfg.baseUrl || 'http://localhost').hostname}>`;
    let sent = 0, failed = 0;
    try {
      for (const m of this.app.db.all('SELECT * FROM email_outbox WHERE sent_at IS NULL ORDER BY id LIMIT ?', limit)) {
        try {
          await t.sendMail({ from, to: m.to_addr, subject: m.subject, text: m.body });
          this.app.db.run('UPDATE email_outbox SET sent_at = ?, error = NULL WHERE id = ?', now(), m.id);
          sent++;
        } catch (e) {
          this.app.db.run('UPDATE email_outbox SET error = ? WHERE id = ?', String(e.message).slice(0, 300), m.id);
          failed++;
        }
      }
    } finally { this._busy = false; }
    return { sent, failed, configured: true };
  }

  start(intervalMs = 30000) {
    clearInterval(this._timer);
    this._timer = setInterval(() => this.flush().catch(() => {}), intervalMs);
    this._timer.unref?.();
  }
  stop() { clearInterval(this._timer); }
}
