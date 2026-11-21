'use strict';

const fs = require('fs');
const path = require('path');

const API_DEFAULT = 'https://api.netlify.com/api/v1';
const FORM_NAME = 'sighting';
const MAX_PAGES = 20;
const PER_PAGE = 100;
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv'
};

function isNetlifyBuild(env) {
  return env.NETLIFY === 'true' || env.NETLIFY === '1' || Boolean(env.CONTEXT);
}

function emptyResult(now) {
  return {
    generatedAt: now().toISOString(),
    source: 'empty',
    sightings: []
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectSightings(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || global.fetch;
  const log = options.log || console;
  const sleep = options.sleep || delay;
  const now = options.now || (() => new Date());
  const apiBase = String(env.NETLIFY_API_BASE || API_DEFAULT).replace(/\/+$/, '');
  const saveMedia = options.saveMedia || (async () => null);
  const loadSamples = options.loadSamples || defaultLoadSamples;

  if (env.ZOMMER_DATA === 'empty') {
    log.info('ZOMMER_DATA=empty. Publishing an empty adventure list.');
    return emptyResult(now);
  }

  const onNetlify = isNetlifyBuild(env);
  const token = String(env.NETLIFY_API_TOKEN || '').trim();
  const siteId = String(env.SITE_ID || '').trim();

  if (onNetlify && env.ZOMMER_DATA === 'sample') {
    log.warn('Ignoring ZOMMER_DATA=sample during a Netlify build.');
  }

  const wantSample = !onNetlify && (env.ZOMMER_DATA === 'sample' || !token || !siteId);
  if (wantSample) {
    if (!token || !siteId) {
      log.info('No NETLIFY_API_TOKEN or SITE_ID. Local build will use sample sightings.');
    } else {
      log.info('ZOMMER_DATA=sample. Using sample sightings.');
    }
    const sightings = loadSamples().map(normalizeSample);
    dedupeIds(sightings);
    sortNewest(sightings);
    return {
      generatedAt: now().toISOString(),
      source: 'sample',
      sightings
    };
  }

  if (!token || !siteId) {
    log.warn('NETLIFY_API_TOKEN or SITE_ID is missing. Publishing an empty adventure list so the build can succeed.');
    return emptyResult(now);
  }

  if (env.INCOMING_HOOK_BODY || env.INCOMING_HOOK_URL) {
    log.info('Build hook detected. Waiting 5s so a new submission can settle.');
    await sleep(5000);
  }

  try {
    const raw = await fetchVerifiedSubmissions({ apiBase, token, siteId, fetchImpl, log });
    const sightings = [];
    for (const item of raw) {
      const normalized = normalizeSubmission(item);
      if (!normalized) continue;
      const ready = await materialize(normalized, saveMedia, log);
      if (ready) sightings.push(ready);
    }
    dedupeIds(sightings);
    sortNewest(sightings);
    log.info(`Published ${sightings.length} verified sighting${sightings.length === 1 ? '' : 's'}.`);
    return {
      generatedAt: now().toISOString(),
      source: 'netlify',
      sightings
    };
  } catch (err) {
    log.warn(`Could not read Netlify form submissions (${err.message}). Publishing an empty adventure list.`);
    return emptyResult(now);
  }
}

async function fetchVerifiedSubmissions({ apiBase, token, siteId, fetchImpl, log }) {
  const formsUrl = `${apiBase}/sites/${encodeURIComponent(siteId)}/forms`;
  const formsRes = await fetchJson(formsUrl, token, fetchImpl);
  if (!Array.isArray(formsRes.data)) throw new Error('Forms response was not a list');
  const form = formsRes.data.find((entry) => entry && entry.name === FORM_NAME);
  if (!form || !form.id) {
    log.warn('No Netlify form named "sighting" yet. The adventure list will be empty until the form is detected.');
    return [];
  }

  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${apiBase}/forms/${encodeURIComponent(form.id)}/submissions?per_page=${PER_PAGE}&page=${page}`;
    const res = await fetchJson(url, token, fetchImpl);
    if (!Array.isArray(res.data)) throw new Error('Submissions response was not a list');
    all.push(...res.data);
    const link = res.headers.get('link') || '';
    if (res.data.length < PER_PAGE) break;
    if (link && !/rel="next"/i.test(link)) break;
  }
  if (all.length >= MAX_PAGES * PER_PAGE) {
    log.warn(`Stopped after ${MAX_PAGES} pages of submissions.`);
  }
  return all;
}

async function fetchJson(url, token, fetchImpl) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(20000)
      });
      if (response.status >= 500 && attempt < 3) {
        await response.text().catch(() => '');
        await delay(400 * attempt);
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        const err = new Error(`HTTP ${response.status}`);
        err.status = response.status;
        throw err;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('Response was not JSON');
      }
      return { data, headers: response.headers };
    } catch (err) {
      lastError = err;
      if (err.status && err.status < 500) throw err;
      if (attempt < 3) {
        await delay(400 * attempt);
        continue;
      }
    }
  }
  throw lastError || new Error('Request failed');
}

function normalizeSubmission(sub) {
  if (!sub || typeof sub !== 'object') return null;
  if (sub.spam === true || sub.state === 'spam') return null;
  const data = sub.data && typeof sub.data === 'object' ? sub.data : {};
  const honeypot = pick(data, 'bot-field', 'bot_field');
  if (typeof honeypot === 'string' && honeypot.trim()) return null;

  const lat = parseCoord(pick(data, 'latitude', 'lat'));
  const lng = parseCoord(pick(data, 'longitude', 'lng', 'lon'));
  if (!validCoord(lat, lng)) return null;

  const story = clip(stringField(pick(data, 'story')), 5000);
  const finderName = clip(stringField(pick(data, 'finder-name', 'finder_name')), 80);
  const seenAt = stringField(pick(data, 'seen-at', 'seen_at')) || null;
  const photo = extractFile(pick(data, 'photo'));
  const video = extractFile(pick(data, 'video'));
  if (!story && !photo && !video) return null;

  const id = String(sub.id || sub.number || '').trim();
  if (!id) return null;

  return {
    id,
    sample: false,
    finderName: finderName || null,
    lat,
    lng,
    story: story || null,
    seenAt,
    createdAt: typeof sub.created_at === 'string' ? sub.created_at : null,
    _photo: photo,
    _video: video
  };
}

function normalizeSample(item) {
  if (!item || item.sample !== true) {
    throw new Error('Sample sighting is missing sample: true');
  }
  const id = String(item.id || '').trim();
  if (!id) throw new Error('Sample sighting is missing an id');
  const story = stringField(item.story);
  if (!story.includes('[SAMPLE]')) {
    throw new Error(`Sample sighting ${id} must include [SAMPLE] in the story`);
  }
  if (item.finderName && !String(item.finderName).includes('SAMPLE')) {
    throw new Error(`Sample finder name must include SAMPLE (${id})`);
  }
  const lat = parseCoord(item.lat);
  const lng = parseCoord(item.lng);
  if (!validCoord(lat, lng)) throw new Error(`Sample sighting ${id} has bad coordinates`);
  const photo = item.photo || null;
  const video = item.video || null;
  if (photo && !isSafePublicPath(photo)) throw new Error(`Bad sample photo path on ${id}`);
  if (video && !isSafePublicPath(video)) throw new Error(`Bad sample video path on ${id}`);
  if (!story && !photo && !video) throw new Error(`Sample sighting ${id} has no content`);
  return {
    id,
    sample: true,
    finderName: item.finderName ? String(item.finderName) : null,
    lat,
    lng,
    story,
    seenAt: item.seenAt || null,
    createdAt: item.createdAt || null,
    photo,
    video,
    photoAlt: item.photoAlt ? String(item.photoAlt) : 'Sample illustration of Zoomer'
  };
}

async function materialize(sighting, saveMedia, log) {
  let photo = null;
  let video = null;
  if (sighting._photo) {
    try {
      photo = await saveMedia(sighting._photo, sighting.id, 'photo');
    } catch (err) {
      log.warn(`Skipping photo for ${sighting.id}: ${err.message}`);
    }
  }
  if (sighting._video) {
    try {
      video = await saveMedia(sighting._video, sighting.id, 'video');
    } catch (err) {
      log.warn(`Skipping video for ${sighting.id}: ${err.message}`);
    }
  }
  if (!sighting.story && !photo && !video) return null;
  return {
    id: sighting.id,
    sample: false,
    finderName: sighting.finderName,
    lat: sighting.lat,
    lng: sighting.lng,
    story: sighting.story,
    seenAt: sighting.seenAt,
    createdAt: sighting.createdAt,
    photo: photo || null,
    video: video || null,
    photoAlt: photo ? 'Photo from this Zoomer sighting' : null
  };
}

function createMediaSaver({ destDir, token, fetchImpl, log }) {
  return async function saveMedia(fileInfo, id, field) {
    const saved = await downloadSubmissionFile({ fileInfo, id, field, token, fetchImpl });
    if (!saved) {
      if (log) log.warn(`No ${field} file saved for submission ${id}.`);
      return null;
    }
    const folder = safeId(id);
    const dir = path.join(destDir, folder);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${field}.${saved.ext}`;
    fs.writeFileSync(path.join(dir, filename), saved.buffer);
    return `/media/sightings/${folder}/${filename}`;
  };
}

async function downloadSubmissionFile({ fileInfo, id, field, token, fetchImpl }) {
  const urls = candidateUrls(fileInfo, id, field);
  for (const url of urls) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000)
      });
    } catch {
      continue;
    }
    if (!response.ok) {
      if (typeof response.text === 'function') await response.text().catch(() => '');
      continue;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) continue;
    const headerType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const type = MIME_EXT[headerType] ? headerType : sniffType(bytes);
    const ext = MIME_EXT[type];
    if (!ext) continue;
    return { buffer: bytes, ext };
  }
  return null;
}

function candidateUrls(fileInfo, id, field) {
  const urls = [];
  const push = (value) => {
    if (typeof value !== 'string' || !value) return;
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return;
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.netlify.com') return;
    if (!urls.includes(parsed.href)) urls.push(parsed.href);
  };
  if (fileInfo && fileInfo.url) push(fileInfo.url);
  push(`https://api.netlify.com/api/v1/submissions/${encodeURIComponent(id)}/files/${encodeURIComponent(field)}`);
  if (fileInfo && fileInfo.filename) {
    push(`https://api.netlify.com/api/v1/submissions/${encodeURIComponent(id)}/files/${encodeURIComponent(fileInfo.filename)}`);
  }
  return urls;
}

function sniffType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  const head6 = buf.subarray(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 8 && buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  return '';
}

function extractFile(value) {
  if (!value) return null;
  if (Array.isArray(value)) return extractFile(value[0]);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^https:\/\//i.test(trimmed)) return { url: trimmed, filename: null };
    return { url: null, filename: trimmed };
  }
  if (typeof value === 'object') {
    const url = typeof value.url === 'string' ? value.url : (typeof value.href === 'string' ? value.href : null);
    const filename = typeof value.filename === 'string' ? value.filename : (typeof value.name === 'string' ? value.name : null);
    if (!url && !filename) return null;
    return { url, filename };
  }
  return null;
}

function pick(data, ...keys) {
  const lower = new Map(Object.entries(data).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      const direct = unwrap(data[key]);
      if (direct != null && direct !== '') return direct;
    }
    if (lower.has(key.toLowerCase())) {
      const folded = unwrap(lower.get(key.toLowerCase()));
      if (folded != null && folded !== '') return folded;
    }
  }
  return undefined;
}

function unwrap(value) {
  if (Array.isArray(value)) return unwrap(value[0]);
  return value;
}

function parseCoord(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

function validCoord(lat, lng) {
  return lat != null && lng != null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function stringField(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return '';
  return value.trim();
}

function clip(value, max) {
  if (!value) return '';
  return value.length > max ? value.slice(0, max) : value;
}

function isSafePublicPath(value) {
  return typeof value === 'string' && /^\/(assets|media)\/[a-zA-Z0-9._/-]+$/.test(value) && !value.includes('..');
}

function safeId(id) {
  const cleaned = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return cleaned || 'sighting';
}

function sortNewest(list) {
  list.sort((a, b) => {
    const byTime = sortKey(b).localeCompare(sortKey(a));
    if (byTime) return byTime;
    return String(b.id).localeCompare(String(a.id));
  });
}

function sortKey(sighting) {
  return String(sighting.seenAt || sighting.createdAt || '');
}

function dedupeIds(list) {
  const seen = new Map();
  for (const item of list) {
    const base = item.id;
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    if (count > 0) item.id = `${base}-${count + 1}`;
  }
}

function defaultLoadSamples() {
  const file = path.join(__dirname, '..', 'data', 'sample-sightings.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = {
  FORM_NAME,
  collectSightings,
  normalizeSubmission,
  normalizeSample,
  createMediaSaver,
  extractFile,
  safeId,
  isNetlifyBuild,
  candidateUrls
};
