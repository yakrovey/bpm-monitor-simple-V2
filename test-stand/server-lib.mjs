import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'public');
const EXT_ROOT = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png'
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

export function createServer() {
  return http.createServer((req, res) => {
    const host = req.headers.host || '127.0.0.1';
    const url = new URL(req.url || '/', `http://${host}`);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/ext/')) {
      const rel = pathname.slice('/ext/'.length);
      const file = path.normalize(path.join(EXT_ROOT, rel));
      if (!file.startsWith(EXT_ROOT)) return send(res, 403, 'forbidden');
      if (!fs.existsSync(file)) return send(res, 404, 'not found');
      const ext = path.extname(file);
      return send(res, 200, fs.readFileSync(file), MIME[ext] || 'application/octet-stream');
    }

    if (pathname === '/') pathname = '/dashboard.html';
    const file = path.normalize(path.join(ROOT, pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, 'not found');
    }
    const ext = path.extname(file);
    send(res, 200, fs.readFileSync(file), MIME[ext] || 'application/octet-stream');
  });
}
