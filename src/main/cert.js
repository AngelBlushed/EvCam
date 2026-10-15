'use strict';

const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

const DAY = 86400 * 1000;

function readExisting(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    if (!meta.notAfter || Date.parse(meta.notAfter) - Date.now() < 30 * DAY) return null;
    return {
      key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'),
      cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'),
      fingerprint: meta.fingerprint
    };
  } catch {
    return null;
  }
}

/**
 * Self-signed certificate for the local HTTPS server. Phones must be on a secure
 * origin to access camera and microphone, so plain HTTP is not an option.
 */
async function ensureCertificate(dir, ips = []) {
  const existing = readExisting(dir);
  if (existing) return existing;

  const notBeforeDate = new Date(Date.now() - DAY);
  const notAfterDate = new Date(Date.now() + 365 * DAY);
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip }))
  ];
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'EvCam' }, { name: 'organizationName', value: 'EvCam' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames }
    ]
  });

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'key.pem'), pems.private, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'cert.pem'), pems.cert);
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ notAfter: notAfterDate.toISOString(), fingerprint: pems.fingerprint })
  );
  return { key: pems.private, cert: pems.cert, fingerprint: pems.fingerprint };
}

module.exports = { ensureCertificate };
