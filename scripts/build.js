'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectSightings, createMediaSaver } = require('./sightings');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));
  if (typeof config.siteUrl !== 'string' || !/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/i.test(config.siteUrl)) {
    throw new Error('site.config.json siteUrl must be an https URL');
  }
  config.siteUrl = config.siteUrl.replace(/\/+$/, '');
  const lat = Number(config.map && config.map.lat);
  const lng = Number(config.map && config.map.lng);
  const zoom = Number(config.map && config.map.zoom);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error('site.config.json map.lat is invalid');
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new Error('site.config.json map.lng is invalid');
  if (!Number.isFinite(zoom) || zoom < 1 || zoom > 19) throw new Error('site.config.json map.zoom is invalid');
  if (!Number.isInteger(config.maxUploadBytes) || config.maxUploadBytes < 1) {
    throw new Error('site.config.json maxUploadBytes is invalid');
  }
  if (!Number.isInteger(config.warnUploadBytes) || config.warnUploadBytes < 1 || config.warnUploadBytes >= config.maxUploadBytes) {
    throw new Error('site.config.json warnUploadBytes must be lower than maxUploadBytes');
  }
  config.map = { lat, lng, zoom, label: config.map.label || '' };
  return config;
}

function resolveDist() {
  const fallback = path.join(ROOT, 'dist');
  if (!process.env.ZOOMER_DIST) return fallback;
  const dist = path.resolve(process.env.ZOOMER_DIST);
  const tmp = os.tmpdir();
  const inTmp = dist.startsWith(tmp + path.sep);
  if (dist === fallback || inTmp) return dist;
  throw new Error(`Refusing to use this publish directory: ${dist}`);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'partials') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function applyIncludes(html) {
  return html.replace(/<!-- @@include ([a-z0-9-]+) -->/g, (_, name) => {
    const file = path.join(SRC, 'partials', `${name}.html`);
    if (!fs.existsSync(file)) throw new Error(`Missing partial: ${name}`);
    return fs.readFileSync(file, 'utf8').trimEnd();
  });
}

function canonicalFor(dist, file, siteUrl) {
  const rel = path.relative(dist, file).split(path.sep).join('/');
  if (rel === 'index.html') return `${siteUrl}/`;
  return `${siteUrl}/${rel}`;
}

function injectHtml(dist, config) {
  for (const file of walk(dist)) {
    if (!file.endsWith('.html')) continue;
    let html = fs.readFileSync(file, 'utf8');
    html = applyIncludes(html);
    html = html.replaceAll('__ZOOMER_CANONICAL__', canonicalFor(dist, file, config.siteUrl));
    html = html.replaceAll('__ZOOMER_SITE_URL__', config.siteUrl);
    if (html.includes('__ZOOMER_')) throw new Error(`Unreplaced placeholder in ${path.relative(dist, file)}`);
    fs.writeFileSync(file, html);
  }
}

function writeConfigJs(dist, config) {
  const publicConfig = {
    siteUrl: config.siteUrl,
    siteName: config.siteName || 'Zoomer',
    map: { lat: config.map.lat, lng: config.map.lng, zoom: config.map.zoom },
    maxUploadBytes: config.maxUploadBytes,
    warnUploadBytes: config.warnUploadBytes
  };
  const file = path.join(dist, 'js', 'config.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `window.ZOOMER_CONFIG = ${JSON.stringify(publicConfig)};\n`);
}

function assertFormDetectable(dist) {
  const file = path.join(dist, 'sighting.html');
  const html = fs.readFileSync(file, 'utf8');
  const required = [
    'data-netlify="true"',
    'netlify-honeypot="bot-field"',
    'enctype="multipart/form-data"',
    'name="sighting"',
    'method="POST"',
    'action="/thank-you.html"',
    'name="form-name"',
    'value="sighting"',
    'name="bot-field"',
    'name="latitude"',
    'name="longitude"',
    'name="photo"',
    'accept="image/*"',
    'name="video"',
    'accept="video/*"',
    'name="story"',
    'name="seen-at"',
    'name="finder-name"'
  ];
  for (const bit of required) {
    if (!html.includes(bit)) throw new Error(`Sighting form is missing ${bit}`);
  }
  if (!/<form\b[^>]*\bdata-netlify="true"/.test(html)) {
    throw new Error('The Netlify form tag is not in the static HTML');
  }
  const formBlock = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
  for (const field of ['form-name', 'bot-field', 'latitude', 'longitude', 'photo', 'video', 'story', 'seen-at', 'finder-name']) {
    if (!formBlock.includes(`name="${field}"`)) {
      throw new Error(`Field ${field} is outside the static form`);
    }
  }
}

function unescapeXml(value) {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function assertQr(siteUrl) {
  const svgPath = path.join(ROOT, 'assets', 'qr', 'zoomer-qr.svg');
  const pngPath = path.join(ROOT, 'assets', 'qr', 'zoomer-qr.png');
  if (!fs.existsSync(svgPath) || !fs.existsSync(pngPath)) {
    throw new Error('QR images are missing. Run npm run qr and commit assets/qr/.');
  }
  const svg = fs.readFileSync(svgPath, 'utf8');
  const desc = svg.match(/<desc>([^<]*)<\/desc>/);
  if (!desc || unescapeXml(desc[1].trim()) !== siteUrl) {
    throw new Error(`QR code does not match siteUrl (${siteUrl}). Run npm run qr and commit assets/qr/.`);
  }
  const png = fs.readFileSync(pngPath);
  if (png.length < 24 || png.toString('ascii', 1, 4) !== 'PNG') throw new Error('QR png is not a PNG');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== 1000 || height !== 1000) {
    throw new Error(`QR png must be 1000×1000 (got ${width}×${height}). Run npm run qr.`);
  }
}

function copyQr(dist) {
  const dest = path.join(dist, 'assets', 'qr');
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ['zoomer-qr.png', 'zoomer-qr.svg']) {
    fs.copyFileSync(path.join(ROOT, 'assets', 'qr', name), path.join(dest, name));
  }
}

function assertSampleMedia(dist, payload) {
  if (payload.source !== 'sample') return;
  for (const sighting of payload.sightings) {
    for (const key of ['photo', 'video']) {
      if (!sighting[key]) continue;
      const rel = sighting[key].replace(/^\//, '');
      if (!fs.existsSync(path.join(dist, rel))) {
        throw new Error(`Sample file missing from the site: ${sighting[key]}`);
      }
    }
  }
}

function assertNoToken(dist, token) {
  if (!token || token.length < 12) return;
  const textExt = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.toml', '.md']);
  for (const file of walk(dist)) {
    if (!textExt.has(path.extname(file))) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(token)) {
      throw new Error(`Refusing to publish: API token appeared in ${path.relative(dist, file)}`);
    }
  }
}

async function main() {
  const config = loadConfig();
  const dist = resolveDist();
  assertQr(config.siteUrl);
  fs.rmSync(dist, { recursive: true, force: true });
  copyDir(SRC, dist);
  injectHtml(dist, config);
  writeConfigJs(dist, config);
  copyQr(dist);
  assertFormDetectable(dist);

  const token = String(process.env.NETLIFY_API_TOKEN || '').trim();
  const mediaDir = path.join(dist, 'media', 'sightings');
  const saveMedia = token
    ? createMediaSaver({ destDir: mediaDir, token, fetchImpl: global.fetch, log: console })
    : async () => null;

  const payload = await collectSightings({ saveMedia });
  assertSampleMedia(dist, payload);
  fs.mkdirSync(path.join(dist, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'data', 'sightings.json'), `${JSON.stringify(payload, null, 2)}\n`);
  assertNoToken(dist, token);
  console.log(`Built ${path.relative(ROOT, dist) || dist} (${payload.source}, ${payload.sightings.length} sightings) for ${config.siteUrl}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { main, loadConfig, resolveDist };
