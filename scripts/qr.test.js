'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');

const ROOT = path.join(__dirname, '..');

test('the collar QR matches siteUrl, is 1000px, and keeps a quiet zone', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));
  const svg = fs.readFileSync(path.join(ROOT, 'assets', 'qr', 'zoomer-qr.svg'), 'utf8');
  const desc = svg.match(/<desc>([^<]*)<\/desc>/);
  assert.ok(desc, 'SVG is missing a <desc> with the encoded URL');
  assert.equal(desc[1], config.siteUrl);

  const png = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'assets', 'qr', 'zoomer-qr.png')));
  assert.equal(png.width, 1000);
  assert.equal(png.height, 1000);
  assert.equal(png.data[0], 255);
  assert.equal(png.data[1], 255);
  assert.equal(png.data[2], 255);

  let dark = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] < 80 && png.data[i + 1] < 80 && png.data[i + 2] < 90) dark += 1;
  }
  assert.ok(dark > 1000, 'QR png has no dark modules');

  const code = jsQR(Uint8ClampedArray.from(png.data), png.width, png.height);
  assert.ok(code, 'QR png did not decode');
  assert.equal(code.data, config.siteUrl);
});
