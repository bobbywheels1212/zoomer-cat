'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { main } = require('./build');

const ROOT = path.join(__dirname, '..');

function baseEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ['NETLIFY', 'CONTEXT', 'NETLIFY_API_TOKEN', 'SITE_ID', 'ZOMMER_DATA', 'NETLIFY_API_BASE', 'INCOMING_HOOK_BODY', 'INCOMING_HOOK_URL']) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

function runBuild(extra) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'zoomer-dist-'));
  const result = spawnSync(process.execPath, ['scripts/build.js'], {
    cwd: ROOT,
    env: baseEnv({ ...extra, ZOOMER_DIST: dist }),
    encoding: 'utf8'
  });
  return { ...result, dist };
}

test('local build uses samples, Netlify without a token stays empty, and a bad API does not fail', async () => {
  const local = runBuild({});
  assert.equal(local.status, 0, local.stderr);
  const localData = JSON.parse(fs.readFileSync(path.join(local.dist, 'data', 'sightings.json'), 'utf8'));
  assert.equal(localData.source, 'sample');
  assert.equal(localData.sightings.length, 3);
  const html = fs.readFileSync(path.join(local.dist, 'sighting.html'), 'utf8');
  assert.match(html, /<form\b[^>]*data-netlify="true"/);
  assert.match(html, /netlify-honeypot="bot-field"/);
  assert.match(html, /enctype="multipart\/form-data"/);
  assert.match(html, /action="\/thank-you\.html"/);
  assert.equal(html.includes('<!-- @@include'), false);
  assert.match(html, /https:\/\/zoomer-the-cat\.netlify\.app\/sighting\.html/);
  assert.match(fs.readFileSync(path.join(local.dist, 'index.html'), 'utf8'), /TODO: Owner name/);
  assert.match(fs.readFileSync(path.join(local.dist, 'js', 'config.js'), 'utf8'), /zoomer-the-cat\.netlify\.app/);
  const tag = fs.readFileSync(path.join(local.dist, 'collar-tag.html'), 'utf8');
  assert.match(tag, /https:\/\/zoomer-the-cat\.netlify\.app/);
  assert.equal(tag.includes('__ZOOMER_'), false);

  const prod = runBuild({ NETLIFY: 'true', CONTEXT: 'production' });
  assert.equal(prod.status, 0, prod.stderr);
  const prodData = JSON.parse(fs.readFileSync(path.join(prod.dist, 'data', 'sightings.json'), 'utf8'));
  assert.equal(prodData.source, 'empty');
  assert.deepEqual(prodData.sightings, []);
  assert.match(fs.readFileSync(path.join(prod.dist, 'sighting.html'), 'utf8'), /data-netlify="true"/);

  const token = 'zoomer-test-token-do-not-leak';
  const api = http.createServer((req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('nope');
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'zoomer-dist-'));
  const previous = {
    NETLIFY: process.env.NETLIFY,
    NETLIFY_API_TOKEN: process.env.NETLIFY_API_TOKEN,
    SITE_ID: process.env.SITE_ID,
    NETLIFY_API_BASE: process.env.NETLIFY_API_BASE,
    ZOOMER_DIST: process.env.ZOOMER_DIST,
    CONTEXT: process.env.CONTEXT
  };
  process.env.NETLIFY = 'true';
  process.env.NETLIFY_API_TOKEN = token;
  process.env.SITE_ID = 'site-123';
  process.env.NETLIFY_API_BASE = `http://127.0.0.1:${api.address().port}`;
  process.env.ZOOMER_DIST = dist;
  delete process.env.CONTEXT;
  try {
    await main();
  } finally {
    api.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const failedData = JSON.parse(fs.readFileSync(path.join(dist, 'data', 'sightings.json'), 'utf8'));
  assert.equal(failedData.source, 'empty');
  const published = fs.readFileSync(path.join(dist, 'data', 'sightings.json'), 'utf8')
    + fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
    + fs.readFileSync(path.join(dist, 'js', 'config.js'), 'utf8');
  assert.equal(published.includes(token), false);
});
