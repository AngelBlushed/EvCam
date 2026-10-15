'use strict';
// Generates every icon / installer bitmap from build/icon.svg.
//   node scripts/build-icons.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;

const root = path.join(__dirname, '..');
const svgPath = path.join(root, 'build', 'icon.svg');
const svg = fs.readFileSync(svgPath);

const render = (size) => sharp(svg, { density: 384 }).resize(size, size, { kernel: 'lanczos3' }).png().toBuffer();

/** Minimal 24-bit BMP writer (NSIS only reads BMP for its sidebar / header images). */
function toBmp(raw, width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3;
      const dst = (height - 1 - y) * rowSize + x * 3;
      data[dst] = raw[src + 2];
      data[dst + 1] = raw[src + 1];
      data[dst + 2] = raw[src];
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + data.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(data.length, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);
  return Buffer.concat([header, data]);
}

function sidebarSvg(w, h) {
  const icon = Buffer.from(svg).toString('utf8').replace(/<\/?svg[^>]*>/g, '');
  const scale = (w * 0.74) / 512;
  const tx = (w - 512 * scale) / 2;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="sb" x1="0" y1="0" x2="0.6" y2="1">
        <stop offset="0" stop-color="#2a1d78"/><stop offset="0.55" stop-color="#120e36"/><stop offset="1" stop-color="#07071a"/>
      </linearGradient>
      <radialGradient id="g1" cx="0.2" cy="0.1" r="0.9"><stop offset="0" stop-color="#7c6cff" stop-opacity="0.55"/><stop offset="1" stop-color="#7c6cff" stop-opacity="0"/></radialGradient>
      <radialGradient id="g2" cx="0.9" cy="1" r="0.8"><stop offset="0" stop-color="#2cc7ff" stop-opacity="0.38"/><stop offset="1" stop-color="#2cc7ff" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#sb)"/>
    <rect width="${w}" height="${h}" fill="url(#g1)"/>
    <rect width="${w}" height="${h}" fill="url(#g2)"/>
    <g transform="translate(${tx} ${h * 0.2}) scale(${scale})">${icon}</g>
  </svg>`);
}

async function main() {
  const png1024 = await render(1024);
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), png1024);

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const buffers = await Promise.all(sizes.map(render));
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), await pngToIco(buffers));

  // phone web client
  fs.copyFileSync(svgPath, path.join(root, 'src', 'phone', 'logo.svg'));
  fs.writeFileSync(path.join(root, 'src', 'phone', 'icon-192.png'), await render(192));

  // desktop UI
  const assets = path.join(root, 'src', 'renderer', 'assets');
  fs.mkdirSync(assets, { recursive: true });
  fs.copyFileSync(svgPath, path.join(assets, 'logo.svg'));

  // NSIS installer artwork (164x314 sidebar)
  const sbW = 164, sbH = 314;
  const raw = await sharp(sidebarSvg(sbW, sbH)).removeAlpha().raw().toBuffer();
  fs.writeFileSync(path.join(root, 'build', 'installerSidebar.bmp'), toBmp(raw, sbW, sbH));

  // Android app: adaptive-icon foreground, pairing-screen assets
  const android = path.join(root, 'android');
  fs.mkdirSync(path.join(android, 'res', 'drawable-xxxhdpi'), { recursive: true });
  fs.mkdirSync(path.join(android, 'assets'), { recursive: true });
  const fg = fs.readFileSync(path.join(root, 'build', 'icon-foreground.svg'));
  await sharp(fg, { density: 384 }).resize(432, 432).png().toFile(path.join(android, 'res', 'drawable-xxxhdpi', 'ic_launcher_foreground.png'));
  fs.copyFileSync(svgPath, path.join(android, 'assets', 'logo.svg'));
  fs.copyFileSync(path.join(root, 'node_modules', 'jsqr', 'dist', 'jsQR.js'), path.join(android, 'assets', 'jsQR.js'));

  console.log('icons generated');
}

main().catch((err) => { console.error(err); process.exit(1); });
