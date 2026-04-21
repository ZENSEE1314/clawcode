import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'https://ollama.com';
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';
const STATIC_ROOT = fileURLToPath(new URL('.', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function proxyChat(req, res) {
  if (!OLLAMA_API_KEY) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: 'OLLAMA_API_KEY is not set on the server. Set it in Railway → Variables.' }
    }));
    return;
  }
  const body = await readBody(req);
  try {
    const upstream = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${OLLAMA_API_KEY}`,
        'content-type': 'application/json',
      },
      body,
    });
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `upstream error: ${err.message}` } }));
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const safe = normalize(pathname).replace(/^([./\\])+/, '');
  const filePath = join(STATIC_ROOT, safe);
  if (!filePath.startsWith(STATIC_ROOT + sep) && filePath !== STATIC_ROOT) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    const content = await readFile(filePath);
    const mime = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
    await proxyChat(req, res);
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    await serveStatic(req, res);
    return;
  }
  res.writeHead(405); res.end('method not allowed');
});

server.listen(PORT, () => {
  console.log(`claw-code web listening on :${PORT}`);
  console.log(`upstream ollama: ${OLLAMA_URL}`);
  console.log(`api key: ${OLLAMA_API_KEY ? 'set' : 'MISSING — set OLLAMA_API_KEY'}`);
});
