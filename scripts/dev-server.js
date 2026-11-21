'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { main: build } = require('./build');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon'
};

function readCsp() {
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  const match = toml.match(/Content-Security-Policy\s*=\s*"([^"]+)"/);
  if (!match) throw new Error('Content-Security-Policy is missing from netlify.toml');
  return match[1];
}

function safeFile(urlPath) {
  const pathname = decodeURIComponent(urlPath.split('?')[0]);
  if (pathname.includes('\0')) return null;
  const rel = path.normalize(pathname).replace(/^([/\\])+/, '');
  const file = path.resolve(DIST, rel);
  if (file !== DIST && !file.startsWith(DIST + path.sep)) return null;
  return file;
}

function send(res, status, body, type, extra = {}) {
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': readCsp(),
    ...extra
  };
  res.writeHead(status, headers);
  res.end(body);
}

function startServer() {
  let lastPost = { received: false };
  const server = http.createServer((req, res) => {
    const host = req.headers.host || '127.0.0.1';
    const url = new URL(req.url || '/', `http://${host}`);

    if (req.method === 'GET' && url.pathname === '/__test__/last-post') {
      send(res, 200, JSON.stringify(lastPost), 'application/json; charset=utf-8');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__test__/reset') {
      lastPost = { received: false };
      send(res, 200, '{"ok":true}', 'application/json; charset=utf-8');
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/thank-you.html' || url.pathname === '/sighting.html')) {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 2 * 1024 * 1024) chunks.push(chunk);
      });
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        lastPost = {
          received: true,
          url: url.pathname,
          contentType: req.headers['content-type'] || '',
          bytes: size,
          truncated: size > 2 * 1024 * 1024,
          body
        };
        send(res, 200, '<!DOCTYPE html><title>Thanks</title><p>Received.</p>', 'text/html; charset=utf-8');
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
      return;
    }

    let file = safeFile(url.pathname);
    if (!file) {
      send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
      return;
    }
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      const missing = path.join(DIST, '404.html');
      if (fs.existsSync(missing)) {
        send(res, 404, fs.readFileSync(missing), 'text/html; charset=utf-8');
      } else {
        send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      }
      return;
    }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const body = fs.readFileSync(file);
    if (req.method === 'HEAD') {
      send(res, 200, '', type, { 'Content-Length': body.length });
      return;
    }
    send(res, 200, body, type);
  });

  const requested = process.env.PORT != null && process.env.PORT !== '' ? Number(process.env.PORT) : 4321;
  server.listen(requested, '127.0.0.1', () => {
    const address = server.address();
    console.log(`READY http://127.0.0.1:${address.port}`);
  });
  return server;
}

async function main() {
  if (!process.argv.includes('--no-build')) {
    await build();
  }
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error('dist/index.html is missing. Run npm run build first.');
  }
  startServer();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
}

module.exports = { startServer };
