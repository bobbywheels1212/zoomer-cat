'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  collectSightings,
  normalizeSubmission,
  createMediaSaver,
  candidateUrls
} = require('./sightings');

const quiet = { info() {}, warn() {} };

function jsonResponse(body, status = 200, headers = {}) {
  const text = JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower[String(name).toLowerCase()] || null },
    text: async () => text,
    arrayBuffer: async () => Buffer.from(text)
  };
}

test('sample stories are labeled and newest is first', async () => {
  const result = await collectSightings({ env: {}, log: quiet });
  assert.equal(result.source, 'sample');
  assert.equal(result.sightings.length, 3);
  assert.equal(result.sightings[0].id, 'sample-bakery');
  for (const sighting of result.sightings) {
    assert.equal(sighting.sample, true);
    assert.match(sighting.story, /\[SAMPLE\]/);
  }
  assert.equal(result.sightings[1].video, '/assets/samples/sunny-car.mp4');
  assert.equal(result.sightings[1].finderName, null);
});

test('ZOMMER_DATA=empty and Netlify without a token skip samples', async () => {
  const empty = await collectSightings({ env: { ZOMMER_DATA: 'empty' }, log: quiet });
  assert.equal(empty.source, 'empty');
  assert.deepEqual(empty.sightings, []);

  const netlify = await collectSightings({ env: { NETLIFY: 'true', CONTEXT: 'production' }, log: quiet });
  assert.equal(netlify.source, 'empty');
  assert.deepEqual(netlify.sightings, []);
});

test('verified submissions are kept and spam, honeypot, and pinless notes are dropped', async () => {
  const calls = [];
  const submissions = [
    {
      id: 'good',
      created_at: '2026-11-20T12:00:00Z',
      data: {
        latitude: '37.760000',
        longitude: '-122.420000',
        story: 'On the steps',
        'seen-at': '2026-11-20T11:30',
        'finder-name': 'Ada',
        photo: { url: 'https://api.netlify.com/api/v1/submissions/good/files/photo', filename: 'cat.jpg' }
      }
    },
    { id: 'spam-flag', spam: true, data: { latitude: '10', longitude: '10', story: 'buy now' } },
    { id: 'spam-state', state: 'spam', data: { latitude: '10', longitude: '10', story: 'spam' } },
    { id: 'bot', data: { latitude: '10', longitude: '10', story: 'hello', 'bot-field': 'https://spam.example' } },
    { id: 'no-pin', data: { story: 'I saw a cat' } },
    { id: 'blank', data: { latitude: '10', longitude: '10', story: '   ' } }
  ];
  const result = await collectSightings({
    env: { NETLIFY: 'true', NETLIFY_API_TOKEN: 'token-token-token', SITE_ID: 'site-1' },
    log: quiet,
    fetchImpl: async (url) => {
      if (String(url).includes('/submissions')) return jsonResponse(submissions);
      return jsonResponse([{ id: 'form-1', name: 'sighting' }]);
    },
    saveMedia: async (file, id, field) => {
      calls.push({ file, id, field });
      return `/media/sightings/${id}/${field}.jpg`;
    }
  });
  assert.equal(result.source, 'netlify');
  assert.equal(result.sightings.length, 1);
  assert.equal(result.sightings[0].id, 'good');
  assert.equal(result.sightings[0].finderName, 'Ada');
  assert.equal(result.sightings[0].photo, '/media/sightings/good/photo.jpg');
  assert.equal(result.sightings[0].sample, false);
  assert.equal(calls.length, 1);
});

test('a missing form or a failed API still returns an empty list', async () => {
  const missing = await collectSightings({
    env: { NETLIFY: 'true', NETLIFY_API_TOKEN: 'token-token-token', SITE_ID: 'site-1' },
    log: quiet,
    fetchImpl: async () => jsonResponse([{ id: 'other', name: 'contact' }])
  });
  assert.equal(missing.source, 'netlify');
  assert.deepEqual(missing.sightings, []);

  const failed = await collectSightings({
    env: { NETLIFY: 'true', NETLIFY_API_TOKEN: 'token-token-token', SITE_ID: 'site-1' },
    log: quiet,
    fetchImpl: async () => { throw new Error('network down'); }
  });
  assert.equal(failed.source, 'empty');
  assert.deepEqual(failed.sightings, []);
});

test('build hooks wait before reading submissions, and pages are followed', async () => {
  let waited = 0;
  let pages = 0;
  const result = await collectSightings({
    env: {
      NETLIFY: 'true',
      NETLIFY_API_TOKEN: 'token-token-token',
      SITE_ID: 'site-1',
      INCOMING_HOOK_URL: 'https://api.netlify.com/build_hooks/example'
    },
    log: quiet,
    sleep: async (ms) => { waited += ms; },
    fetchImpl: async (url) => {
      const href = String(url);
      if (!href.includes('/submissions')) return jsonResponse([{ id: 'form-1', name: 'sighting' }]);
      pages += 1;
      if (pages === 1) {
        const batch = Array.from({ length: 100 }, (_, index) => ({
          id: `p1-${index}`,
          data: { latitude: '37.75', longitude: '-122.41', story: `One ${index}`, 'seen-at': '2026-11-02T01:00' }
        }));
        return jsonResponse(batch, 200, { link: '<https://api.netlify.com/next>; rel="next"' });
      }
      return jsonResponse([
        { id: 'p2-1', data: { latitude: '37.76', longitude: '-122.42', story: 'Two', 'seen-at': '2026-11-03T01:00' } }
      ]);
    }
  });
  assert.equal(waited, 5000);
  assert.equal(pages, 2);
  assert.equal(result.sightings.length, 101);
  assert.equal(result.sightings[0].id, 'p2-1');
});

test('media downloads stay on api.netlify.com and skip SVG payloads', async () => {
  const calls = [];
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'zoomer-media-'));
  const save = createMediaSaver({
    destDir: dest,
    token: 'token-token-token',
    log: quiet,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/files/photo')) {
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'image/png' : null) },
          arrayBuffer: async () => png,
          text: async () => ''
        };
      }
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => 'no', arrayBuffer: async () => Buffer.alloc(0) };
    }
  });

  const evil = candidateUrls({ url: 'https://evil.example/cat.jpg', filename: 'cat.jpg' }, 'abc', 'photo');
  assert.ok(evil.every((url) => url.startsWith('https://api.netlify.com/')));
  assert.equal(evil.some((url) => url.includes('evil.example')), false);

  const saved = await save({ url: 'https://evil.example/cat.jpg', filename: 'cat.jpg' }, 'abc', 'photo');
  assert.equal(saved, '/media/sightings/abc/photo.png');
  assert.ok(fs.existsSync(path.join(dest, 'abc', 'photo.png')));
  assert.ok(calls.every((url) => url.startsWith('https://api.netlify.com/')));

  const svg = await save({ url: 'https://api.netlify.com/api/v1/submissions/abc/files/drawing.svg' }, 'abc', 'video');
  assert.equal(svg, null);

  const dropped = normalizeSubmission({
    id: 'nope',
    data: { latitude: '1', longitude: '2', story: '   ' }
  });
  assert.equal(dropped, null);
});
