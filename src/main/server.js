'use strict';

const net = require('net');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};

const PHONE_FILES = new Set(['index.html', 'phone.js', 'phone.css', 'logo.svg', 'icon-192.png', 'manifest.webmanifest']);

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Local HTTPS server the phone connects to. One TCP port serves both HTTPS and
 * (as a redirect) plain HTTP, so typing the address without "https://" still works.
 */
class PairingServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.phoneDir directory holding the phone web client
   * @param {() => string} opts.getToken
   * @param {string} opts.version
   * @param {() => object} [opts.getPrefs] phone preferences ({codec, eco}) exposed to authorised phones
   * @param {() => string} [opts.getApkPath] location of the Android app served at /evcam.apk
   * @param {{offer:Function, bye:Function}} opts.handlers
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.port = 0;
    this.failures = new Map();
    this.tcp = null;
    this.httpsServer = null;
    this.httpServer = null;
  }

  async start(preferredPort, tls) {
    await this.stop();

    this.httpsServer = https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, (req, res) => this._handle(req, res));
    this.httpsServer.on('tlsClientError', () => { /* browsers abort when they distrust the certificate */ });
    this.httpServer = http.createServer((req, res) => {
      const host = req.headers.host || `localhost:${this.port}`;
      res.writeHead(301, { Location: `https://${host}${req.url}`, 'Content-Length': 0 });
      res.end();
    });

    this.tcp = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.setTimeout(10000, () => socket.destroy());
      socket.once('data', (buf) => {
        socket.setTimeout(0);
        socket.pause();
        socket.unshift(buf);
        // 0x16 = TLS handshake record; anything else is treated as plain HTTP
        (buf[0] === 0x16 ? this.httpsServer : this.httpServer).emit('connection', socket);
        process.nextTick(() => socket.resume());
      });
    });

    for (let i = 0; i < 25; i++) {
      const candidate = preferredPort + i;
      try {
        await new Promise((resolve, reject) => {
          const onError = (err) => reject(err);
          this.tcp.once('error', onError);
          this.tcp.listen(candidate, '0.0.0.0', () => {
            this.tcp.off('error', onError);
            resolve();
          });
        });
        this.port = candidate;
        this.tcp.on('error', (err) => console.error('[server]', err.message));
        return this.port;
      } catch (err) {
        if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
      }
    }
    throw new Error('Aucun port libre trouvé pour le serveur local.');
  }

  async stop() {
    const close = (srv) => new Promise((resolve) => (srv ? srv.close(() => resolve()) : resolve()));
    const tcp = this.tcp;
    this.tcp = null;
    if (tcp) {
      tcp.unref();
      await new Promise((resolve) => tcp.close(() => resolve()));
    }
    for (const srv of [this.httpsServer, this.httpServer]) if (srv && srv.closeAllConnections) srv.closeAllConnections();
    await Promise.all([close(this.httpsServer), close(this.httpServer)].map((p) => p.catch(() => {})));
    this.httpsServer = null;
    this.httpServer = null;
    this.port = 0;
  }

  // ----- request handling -------------------------------------------------

  _tooManyFailures(ip) {
    const entry = this.failures.get(ip);
    return !!entry && entry.resetAt > Date.now() && entry.count >= 8;
  }

  _recordFailure(ip) {
    const now = Date.now();
    const entry = this.failures.get(ip);
    if (!entry || entry.resetAt < now) this.failures.set(ip, { count: 1, resetAt: now + 60000 });
    else entry.count++;
  }

  _json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length });
    res.end(data);
  }

  async _readJson(req, limit = 128 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error('payload too large'), { status: 413 });
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw Object.assign(new Error('invalid json'), { status: 400 });
    }
  }

  async _serveStatic(res, name) {
    if (!PHONE_FILES.has(name)) return this._json(res, 404, { error: 'not found' });
    try {
      const data = await fs.promises.readFile(path.join(this.opts.phoneDir, name));
      const headers = { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Content-Length': data.length };
      if (name === 'index.html') headers['Content-Security-Policy'] = PAGE_CSP;
      res.writeHead(200, headers);
      res.end(data);
    } catch {
      this._json(res, 404, { error: 'not found' });
    }
  }

  async _serveApk(req, res) {
    const file = this.opts.getApkPath && this.opts.getApkPath();
    try {
      const stat = await fs.promises.stat(file);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': 'attachment; filename="EvCam.apk"',
        'Content-Length': stat.size
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch {
      this._json(res, 404, { error: 'Application Android non incluse dans cette version.' });
    }
  }

  async _handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const ip = req.socket.remoteAddress || '';

    try {
      const url = new URL(req.url, 'https://evcam.local');

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (url.pathname === '/api/info') {
          const token = url.searchParams.get('t') || '';
          const authorized = safeEqual(token, this.opts.getToken());
          const info = { app: 'EvCam', version: this.opts.version, authorized };
          // codec / battery preferences are read by the phone before it connects
          if (authorized && this.opts.getPrefs) info.prefs = this.opts.getPrefs();
          return this._json(res, 200, info);
        }
        if (url.pathname === '/evcam.apk') return await this._serveApk(req, res);
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        return await this._serveStatic(res, name);
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (this._tooManyFailures(ip)) return this._json(res, 429, { error: 'Trop de tentatives, patientez une minute.' });
        const body = await this._readJson(req);
        if (!safeEqual(body.token || '', this.opts.getToken())) {
          this._recordFailure(ip);
          return this._json(res, 403, { error: 'Code de connexion invalide. Scannez à nouveau le QR code.' });
        }
        const ctx = { remote: ip, userAgent: req.headers['user-agent'] || '' };
        if (url.pathname === '/api/offer') {
          if (typeof body.sdp !== 'string' || body.type !== 'offer') return this._json(res, 400, { error: 'offre invalide' });
          const answer = await this.opts.handlers.offer({ sdp: body.sdp, type: 'offer', device: String(body.device || ''), ...ctx });
          return this._json(res, 200, answer);
        }
        if (url.pathname === '/api/bye') {
          await this.opts.handlers.bye(ctx);
          return this._json(res, 200, { ok: true });
        }
      }

      this._json(res, 404, { error: 'not found' });
    } catch (err) {
      this._json(res, err.status || 503, { error: err.message || 'erreur' });
    }
  }
}

module.exports = { PairingServer };
