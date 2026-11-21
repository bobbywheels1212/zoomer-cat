'use strict';

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const ROOT = path.join(__dirname, '..');

function loadUrl() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));
  if (typeof config.siteUrl !== 'string' || !/^https:\/\//.test(config.siteUrl)) {
    throw new Error('site.config.json siteUrl must be an https URL');
  }
  return config.siteUrl.replace(/\/+$/, '');
}

function escapeXml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  }[char]));
}

async function main() {
  const url = loadUrl();
  const dir = path.join(ROOT, 'assets', 'qr');
  fs.mkdirSync(dir, { recursive: true });
  const pngPath = path.join(dir, 'zoomer-qr.png');
  const svgPath = path.join(dir, 'zoomer-qr.svg');

  await QRCode.toFile(pngPath, url, {
    errorCorrectionLevel: 'H',
    type: 'png',
    width: 1000,
    margin: 4,
    color: { dark: '#2b2f36', light: '#ffffff' }
  });

  let svg = await QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'H',
    margin: 4,
    width: 1000,
    color: { dark: '#2b2f36', light: '#ffffff' }
  });
  svg = svg.replace(/<\?xml[^?]*\?>\s*/, '');
  if (!/<svg\b/.test(svg)) throw new Error('QR library returned an empty SVG');
  const described = `<title>QR code for Zoomer</title><desc>${escapeXml(url)}</desc>`;
  svg = svg.replace(/<svg\b([^>]*)>/, `<svg$1>${described}`);
  fs.writeFileSync(svgPath, svg);

  const png = fs.readFileSync(pngPath);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== 1000 || height !== 1000) {
    throw new Error(`Expected a 1000×1000 PNG, got ${width}×${height}`);
  }
  console.log(`Wrote assets/qr/zoomer-qr.png and assets/qr/zoomer-qr.svg for ${url}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
}

module.exports = { main };
