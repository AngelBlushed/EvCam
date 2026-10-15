'use strict';

const os = require('os');

const VIRTUAL_NAME = /vethernet|vmware|virtualbox|vbox|hyper-v|wsl|docker|loopback|bluetooth|tailscale|zerotier|hamachi|vpn|tap-|npcap/i;

function score(address) {
  if (address.startsWith('192.168.')) return 3;
  if (address.startsWith('10.')) return 2;
  const m = /^172\.(\d+)\./.exec(address);
  if (m && +m[1] >= 16 && +m[1] <= 31) return 2;
  if (address.startsWith('169.254.')) return -5; // link-local (no DHCP)
  return 1;
}

/** IPv4 addresses of this PC that a phone on the same network could reach, best first. */
function listAddresses() {
  const out = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const virtual = VIRTUAL_NAME.test(name);
      out.push({ address: info.address, name, virtual, score: score(info.address) - (virtual ? 10 : 0) });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

function pickAddress(list, preferred) {
  return list.find((a) => a.address === preferred) || list[0] || null;
}

module.exports = { listAddresses, pickAddress };
