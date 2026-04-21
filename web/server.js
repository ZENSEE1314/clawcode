import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'https://ollama.com';
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';
// resolve() strips any trailing slash that fileURLToPath leaves on Linux,
// so STATIC_ROOT + sep below produces a single boundary separator.
const STATIC_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

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

/* Browser sends OpenAI-shape `/v1/chat/completions` requests. Ollama Cloud
 * exposes `/api/chat` (native NDJSON streaming). We translate request shape
 * (which is mostly identical) and re-emit each NDJSON line as an OpenAI SSE
 * chunk so the browser's existing parser keeps working. */
async function proxyChat(req, res) {
  if (!OLLAMA_API_KEY) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: 'OLLAMA_API_KEY is not set on the server. Set it in Railway → Variables.' }
    }));
    return;
  }
  const body = await readBody(req);
  let parsed;
  try { parsed = JSON.parse(body); }
  catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }));
    return;
  }

  const ollamaReq = {
    model: parsed.model,
    messages: parsed.messages || [],
    stream: parsed.stream !== false,
    options: {
      ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
      ...(parsed.top_p !== undefined ? { top_p: parsed.top_p } : {}),
      ...(parsed.max_tokens !== undefined ? { num_predict: parsed.max_tokens } : {}),
    },
  };

  try {
    const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${OLLAMA_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(ollamaReq),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `Ollama upstream ${upstream.status}: ${text.slice(0, 500)}`,
          status: upstream.status,
        }
      }));
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const idStr = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let chunk;
        try { chunk = JSON.parse(trimmed); } catch { continue; }
        const content = chunk.message?.content ?? '';
        const finishReason = chunk.done ? (chunk.done_reason || 'stop') : null;
        const sse = {
          id: idStr,
          object: 'chat.completion.chunk',
          created,
          model: chunk.model || ollamaReq.model,
          choices: [{
            index: 0,
            delta: chunk.done ? {} : { role: 'assistant', content },
            finish_reason: finishReason,
          }],
        };
        res.write(`data: ${JSON.stringify(sse)}\n\n`);
        if (chunk.done) {
          res.write('data: [DONE]\n\n');
        }
      }
    }
    res.end();
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `upstream error: ${err.message}` } }));
  }
}

/* ------------------------------------------------------------------
 * Shareable conversation snapshots — for NotebookLM "Web URL" sources.
 * In-memory Map; data is lost on restart (fine for personal use).
 * For persistence, mount a Railway volume and swap to fs-backed JSON.
 * ------------------------------------------------------------------ */
const shares = new Map();
const SHARE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SHARE_MAX = 500;

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function pruneShares() {
  const now = Date.now();
  for (const [k, v] of shares) if (now - v.createdAt > SHARE_TTL_MS) shares.delete(k);
  if (shares.size > SHARE_MAX) {
    const oldest = [...shares.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) shares.delete(oldest[0]);
  }
}

async function createShare(req, res) {
  const body = await readBody(req);
  let payload;
  try { payload = JSON.parse(body); }
  catch { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"invalid json"}'); return; }
  const { title, messages } = payload || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'messages array required' }));
    return;
  }
  const id = [...crypto.getRandomValues(new Uint8Array(9))]
    .map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
  shares.set(id, { title: String(title || 'claw-code conversation'), messages, createdAt: Date.now() });
  pruneShares();
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${proto}://${host}/s/${id}`;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id, url }));
}

function renderShare(id, res) {
  const share = shares.get(id);
  if (!share) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Share not found or expired.'); return; }
  const date = new Date(share.createdAt).toISOString().slice(0, 19).replace('T', ' ');
  const blocks = share.messages.map(m => {
    const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System';
    return `<section><h2>${escHtml(role)}</h2><div class="msg">${escHtml(m.content || '').replace(/\n/g, '<br>')}</div></section>`;
  }).join('\n');
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${escHtml(share.title)}</title>
<meta name="description" content="claw-code conversation snapshot">
<meta name="robots" content="noindex,nofollow">
<style>
  body { font: 16px/1.6 -apple-system, system-ui, sans-serif; max-width: 740px; margin: 2rem auto; padding: 0 1rem; color: #222; background: #fafaf7; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.08em; color: #888; margin-top: 1.5rem; margin-bottom: 0.4rem; }
  .meta { color: #888; font-size: 0.85rem; margin-bottom: 2rem; }
  .msg { padding: 0.75rem 1rem; border-left: 3px solid #d4d4d0; background: #fff; }
  section + section { margin-top: 0.5rem; }
</style></head>
<body>
  <h1>${escHtml(share.title)}</h1>
  <div class="meta">claw-code conversation · ${date} UTC</div>
  ${blocks}
</body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' });
  res.end(html);
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
  if (req.method === 'POST' && req.url === '/api/share') {
    await createShare(req, res);
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/s/')) {
    const id = req.url.slice(3).split('?')[0].split('/')[0];
    if (!/^[a-z0-9]{6,16}$/i.test(id)) { res.writeHead(404); res.end('not found'); return; }
    renderShare(id, res);
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
