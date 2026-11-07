/**
 * The panel's single HTTP entry point.
 *
 *   /            → panel UI
 *   /api/*       → JSON API
 *   /sub/:token  → subscription (all formats)
 *   /u/:token    → self-service page for a subscriber
 *   /nl-xxxx/*   → reverse-proxied into the Xray / sing-box inbound that owns
 *                  that path (WS, HTTPUpgrade, XHTTP, gRPC)
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { ROOT } from '../env.js';
import { handleApi } from './api.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/* Small in-process cache: the panel's assets change only on redeploy. */
const STATIC_CACHE = new Map();

function staticEntry(file) {
  const stat = fs.statSync(file);
  const hit = STATIC_CACHE.get(file);
  if (hit && hit.mtime === stat.mtimeMs) return hit;
  const raw = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const compressible = /^(text\/|application\/(json|javascript|xml))/.test(MIME[ext] || '');
  const entry = {
    mtime: stat.mtimeMs,
    raw,
    gzip: compressible && raw.length > 1024 ? zlib.gzipSync(raw, { level: 6 }) : null,
    type: MIME[ext] || 'application/octet-stream',
    ext,
  };
  STATIC_CACHE.set(file, entry);
  return entry;
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (rel.includes('..')) {
    res.writeHead(400).end('bad request');
    return true;
  }
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const entry = staticEntry(file);
  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = acceptsGzip && entry.gzip ? entry.gzip : entry.raw;
  const headers = {
    'Content-Type': entry.type,
    'Content-Length': body.length,
    // Only truly static binaries (images, fonts) may be cached for good. Code and
    // markup must revalidate every load, otherwise a browser keeps running an old
    // app.js after an in-panel update and half the UI looks "missing".
    'Cache-Control': ['.html', '.js', '.mjs', '.css', '.svg', '.json', '.webmanifest'].includes(entry.ext)
      ? 'no-cache'
      : 'public, max-age=604800',
    ETag: `"${entry.mtime.toString(36)}-${entry.raw.length.toString(36)}"`,
    Vary: 'Accept-Encoding',
  };
  if (entry.gzip && acceptsGzip) headers['Content-Encoding'] = 'gzip';
  if (req.headers['if-none-match'] === headers.ETag) {
    res.writeHead(304, { ETag: headers.ETag, 'Cache-Control': headers['Cache-Control'] });
    res.end();
    return true;
  }
  res.writeHead(200, headers);
  res.end(body);
  return true;
}

export function createPanelServer({ runtime, api }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, at: Date.now() }));
      return;
    }

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sub/') || url.pathname.startsWith('/u/')) {
      handleApi({ req, res, url, runtime, api }).catch((err) => {
        console.error('[api]', err);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal', message: err.message }));
      });
      return;
    }

    // Reverse proxy into the cores (path-routed inbounds).
    for (const route of api.httpRoutes()) {
      if (url.pathname === route.prefix || url.pathname.startsWith(`${route.prefix}/`)) {
        proxyHttp(req, res, route.port);
        return;
      }
    }

    if (serveStatic(req, res, url.pathname)) return;
    if (serveStatic(req, res, '/index.html')) return;
    res.writeHead(404).end('not found');
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    for (const route of api.httpRoutes()) {
      if (url.pathname === route.prefix || url.pathname.startsWith(`${route.prefix}/`)) {
        proxyUpgrade(req, socket, head, route.port);
        return;
      }
    }
    socket.destroy();
  });

  server.keepAliveTimeout = 65000;
  return server;
}

function proxyHttp(req, res, port) {
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  delete headers['accept-encoding'];
  const proxyReq = http.request(
    { host: '127.0.0.1', port, method: req.method, path: req.url, headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('bad gateway');
  });
  req.pipe(proxyReq);
}

function proxyUpgrade(req, socket, head, port) {
  const upstream = net.connect({ host: '127.0.0.1', port }, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
}
