import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = '/opt/cursor/artifacts';
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runBuild(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ['NETLIFY', 'CONTEXT', 'NETLIFY_API_TOKEN', 'SITE_ID', 'NETLIFY_API_BASE', 'INCOMING_HOOK_BODY', 'INCOMING_HOOK_URL', 'ZOMMER_DATA']) {
    if (!(key in extra)) delete env[key];
  }
  const result = spawnSync(process.execPath, ['scripts/build.js'], {
    cwd: ROOT,
    env,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`build failed\n${result.stdout}\n${result.stderr}`);
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/dev-server.js', '--no-build'], {
      cwd: ROOT,
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`dev server did not start\n${buffer}`));
    }, 15000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/READY http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({ child, url: `http://127.0.0.1:${match[1]}` });
    });
    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
    });
    child.on('exit', (code) => {
      if (code) reject(new Error(`dev server exited ${code}\n${buffer}`));
    });
  });
}

async function shot(page, name) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS, name), fullPage: true });
}

async function main() {
  runBuild({});
  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  try {
    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    page.setDefaultTimeout(20000);
    page.on('pageerror', (err) => console.error('PAGEERROR', err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('BROWSER', msg.text());
    });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });

    const sightingHtml = await (await fetch(`${server.url}/sighting.html`)).text();
    for (const bit of [
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
      'type="hidden"',
      'name="longitude"',
      'name="photo"',
      'accept="image/*"',
      'name="video"',
      'accept="video/*"',
      'name="story"',
      'name="seen-at"',
      'name="finder-name"'
    ]) {
      assert(sightingHtml.includes(bit), `served form is missing ${bit}`);
    }
    const csp = (await fetch(server.url)).headers.get('content-security-policy') || '';
    assert(csp.includes('https://cdn.jsdelivr.net'), 'CSP does not allow the Leaflet CDN');
    assert(csp.includes('https://tile.openstreetmap.org'), 'CSP does not allow map tiles');

    await page.goto(`${server.url}/`, { waitUntil: 'networkidle0' });
    const home = await page.evaluate(() => document.body.innerText);
    assert(home.includes('TODO: Owner name'), 'owner name placeholder missing');
    assert(home.includes('TODO: Owner email'), 'owner email placeholder missing');
    assert(home.includes('TODO: Owner phone'), 'owner phone placeholder missing');
    assert(home.includes('I saw Zoomer!'), 'CTA missing');
    const cta = await page.$eval('a.cta', (el) => el.getAttribute('href'));
    assert(cta === '/sighting.html', `CTA href was ${cta}`);
    await shot(page, 'zoomer-home-mobile.png');

    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.goto(`${server.url}/`, { waitUntil: 'networkidle0' });
    await shot(page, 'zoomer-home-desktop.png');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });

    const context = browser.defaultBrowserContext();
    await context.overridePermissions(server.url, ['geolocation']);
    await page.setGeolocation({ latitude: 47.6062, longitude: -122.3321, accuracy: 20 });

    await page.goto(`${server.url}/sighting.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#sighting-map.leaflet-container');
    await page.waitForFunction(() => document.querySelector('#seen-at').value !== '');
    await shot(page, 'zoomer-sighting-mobile.png');

    await page.click('#submit-sighting');
    await page.waitForFunction(() => document.querySelector('#form-errors').textContent.includes('Drop a pin'));
    assert(await page.$eval('#latitude', (el) => el.value) === '', 'latitude was set before a pin');

    await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; });
    const mapHandle = await page.$('#sighting-map');
    await mapHandle.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const box = await mapHandle.boundingBox();
    await mapHandle.click({ offset: { x: box.width / 2, y: box.height / 2 } });
    await page.waitForFunction(() => document.querySelector('#latitude').value !== '');
    const pin = await page.evaluate(() => ({
      lat: Number(document.querySelector('#latitude').value),
      lng: Number(document.querySelector('#longitude').value)
    }));
    assert(pin.lat > 37.7 && pin.lat < 37.82, `map click latitude was ${pin.lat}`);
    assert(pin.lng < -122.38 && pin.lng > -122.46, `map click longitude was ${pin.lng}`);

    await page.click('#submit-sighting');
    await page.waitForFunction(() => /photo, a video, or a short story/i.test(document.querySelector('#form-errors').textContent));

    await page.focus('#sighting-map');
    const beforeLng = await page.$eval('#longitude', (el) => el.value);
    await page.keyboard.press('ArrowRight');
    const afterLng = await page.$eval('#longitude', (el) => el.value);
    assert(beforeLng !== afterLng, 'arrow key did not nudge the pin');

    await page.click('#use-location');
    await page.waitForFunction(() => Number(document.querySelector('#latitude').value).toFixed(3) === '47.606');
    await page.waitForFunction(() => Number(document.querySelector('#longitude').value).toFixed(3) === '-122.332');

    await page.evaluate(() => {
      const input = document.querySelector('#video');
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(8 * 1024 * 1024 + 2048)], 'too-big.mp4', { type: 'video/mp4' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#story').value = 'Saw Zoomer on the steps';
    });
    await page.click('#submit-sighting');
    await page.waitForFunction(() => /too big to send/i.test(document.querySelector('#form-errors').textContent));
    assert(await page.$eval('#thank-you', (el) => el.hidden) === true, 'thank-you showed for an oversized upload');

    await fetch(`${server.url}/__test__/reset`, { method: 'POST' });
    await page.evaluate((png) => {
      const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
      const photo = document.querySelector('#photo');
      const photoTransfer = new DataTransfer();
      photoTransfer.items.add(new File([bytes], 'zoomer.png', { type: 'image/png' }));
      photo.files = photoTransfer.files;
      photo.dispatchEvent(new Event('change', { bubbles: true }));
      const video = document.querySelector('#video');
      video.files = new DataTransfer().files;
      video.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#finder-name').value = 'Ada';
      document.querySelector('#story').value = 'Saw Zoomer on the steps';
    }, TINY_PNG);
    const postedPin = await page.evaluate(() => ({
      lat: document.querySelector('#latitude').value,
      lng: document.querySelector('#longitude').value
    }));
    await page.click('#submit-sighting');
    await page.waitForSelector('#thank-you:not([hidden])');
    assert((await page.url()).includes('/sighting.html'), 'submit navigated away from the in-page thank-you');
    assert(await page.$eval('#sighting-form', (el) => el.hidden) === true, 'form stayed visible after success');
    await shot(page, 'zoomer-thanks-mobile.png');

    const last = await (await fetch(`${server.url}/__test__/last-post`)).json();
    assert(last.received === true, 'dev server did not receive the form POST');
    assert(String(last.contentType).includes('multipart/form-data'), 'POST was not multipart');
    assert(last.body.includes('name="form-name"'), 'form-name was not posted');
    assert(last.body.includes('sighting'), 'form name value was not posted');
    assert(last.body.includes('name="latitude"'), 'latitude field was not posted');
    assert(last.body.includes(postedPin.lat), `posted body did not include latitude ${postedPin.lat}`);
    assert(last.body.includes('name="longitude"'), 'longitude field was not posted');
    assert(last.body.includes(postedPin.lng), `posted body did not include longitude ${postedPin.lng}`);
    assert(last.body.includes('Saw Zoomer on the steps'), 'story was not posted');
    assert(last.body.includes('name="finder-name"'), 'finder name was not posted');
    assert(last.body.includes('zoomer.png'), 'photo was not posted');

    await page.goto(`${server.url}/adventures.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sighting-card');
    const adventures = await page.evaluate(() => ({
      banner: document.querySelector('#sample-banner').hidden,
      cards: document.querySelectorAll('.sighting-card').length,
      pins: document.querySelectorAll('.pin-button').length,
      first: document.querySelector('.sighting-card').innerText,
      empty: document.querySelector('#empty-state').hidden
    }));
    assert(adventures.banner === false, 'sample banner hidden during local preview');
    assert(adventures.cards === 3, `expected 3 cards, saw ${adventures.cards}`);
    assert(adventures.pins === 3, `expected 3 pins, saw ${adventures.pins}`);
    assert(adventures.empty === true, 'empty state showed alongside samples');
    assert(adventures.first.includes('[SAMPLE]'), 'first card was not labeled as a sample');
    assert(adventures.first.includes('bakery steps'), 'gallery was not newest-first');
    await page.click('.sighting-card a');
    await page.waitForSelector('.leaflet-popup');
    const popup = await page.$eval('.leaflet-popup', (el) => el.innerText);
    assert(popup.includes('bakery steps'), 'popup did not open the linked sighting');
    assert(popup.includes('SAMPLE neighbor'), 'popup hid the finder name');
    await shot(page, 'zoomer-adventures-mobile.png');

    await page.goto(`${server.url}/collar-tag.html`, { waitUntil: 'networkidle0' });
    const tag = await page.evaluate(() => document.body.innerText);
    assert(tag.includes("Hi, I'm Zoomer!"), 'collar tag greeting missing');
    assert(tag.includes('Scan to report where you saw me'), 'collar tag instruction missing');
    await shot(page, 'zoomer-collar-tag.png');

    runBuild({ NETLIFY: 'true', CONTEXT: 'production' });
    await page.goto(`${server.url}/adventures.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const empty = document.querySelector('#empty-state');
      return empty && !empty.hidden;
    });
    const emptyText = await page.$eval('#empty-state', (el) => el.innerText);
    assert(emptyText.includes('No adventures yet, be the first to spot Zoomer!'), emptyText);
    assert(await page.$eval('#sample-banner', (el) => el.hidden) === true, 'sample banner showed in the empty production build');
    assert(await page.$$eval('.pin-button', (nodes) => nodes.length) === 0, 'empty map still had pins');
    await shot(page, 'zoomer-adventures-empty.png');

    const thanksPage = await (await fetch(`${server.url}/thank-you.html`)).text();
    assert(thanksPage.includes('You spotted Zoomer!'), 'static thank-you page missing');
    console.log('Browser checks passed');
  } finally {
    await browser.close();
    server.child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
