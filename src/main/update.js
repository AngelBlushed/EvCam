'use strict';

const https = require('https');

const REPO = 'AngelBlushed/EvCam';

const parts = (v) => String(v).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);

/** true when `remote` is a newer x.y.z than `local`. */
function isNewer(remote, local) {
  const a = parts(remote);
  const b = parts(local);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

/**
 * Latest published release: { version, url }, or null when it cannot be read.
 * One small HTTPS request to api.github.com; nothing about the user or the PC is sent.
 */
function latest(timeout = 8000) {
  return new Promise((resolve) => {
    const req = https.get({
      host: 'api.github.com',
      path: `/repos/${REPO}/releases/latest`,
      headers: { 'User-Agent': 'EvCam', Accept: 'application/vnd.github+json' },
      timeout
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 400000) req.destroy(); });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json.tag_name ? { version: String(json.tag_name).replace(/^v/i, ''), url: String(json.html_url || `https://github.com/${REPO}/releases/latest`) } : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

module.exports = { latest, isNewer, REPO };
