import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'https://ollama.com';
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';
// Optional HTTP Basic Auth — both vars must be set to activate. Healthcheck
// is exempt so Railway's probe keeps working without credentials.
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || '';
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS || '';
const AUTH_ENABLED = Boolean(BASIC_AUTH_USER && BASIC_AUTH_PASS);
const EXPECTED_AUTH = AUTH_ENABLED
  ? 'Basic ' + Buffer.from(`${BASIC_AUTH_USER}:${BASIC_AUTH_PASS}`).toString('base64')
  : '';
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

  // Stale model names (e.g. gemma4:31b-cloud after Ollama renamed it) cause
  // every send to 400. Retry once with a known-good model, surface the swap
  // via x-claw-model-fallback so the UI can update the dropdown.
  const MODEL_FALLBACK = 'gpt-oss:120b-cloud';
  const callOllama = (req) => fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${OLLAMA_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });

  try {
    let upstream = await callOllama(ollamaReq);
    let originalModel = null;
    if (
      !upstream.ok &&
      ollamaReq.model && ollamaReq.model !== MODEL_FALLBACK &&
      (upstream.status === 400 || upstream.status === 404 || upstream.status === 422)
    ) {
      try { await upstream.text(); } catch { /* drain */ }
      originalModel = ollamaReq.model;
      const retry = await callOllama({ ...ollamaReq, model: MODEL_FALLBACK });
      if (retry.ok) {
        ollamaReq.model = MODEL_FALLBACK;
        upstream = retry;
      } else {
        upstream = retry;
        originalModel = null;
      }
    }

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

    const respHeaders = {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    };
    if (originalModel) {
      respHeaders['x-claw-model-fallback'] = originalModel;
      respHeaders['x-claw-model-used']     = MODEL_FALLBACK;
      respHeaders['access-control-expose-headers'] = 'x-claw-model-fallback, x-claw-model-used';
    }
    res.writeHead(200, respHeaders);

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const idStr = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    let totalContentLen = 0;
    let lastChunk = null;
    let sentDone = false;

    function writeSse(obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
    function writeSyntheticContent(text) {
      writeSse({
        id: idStr, object: 'chat.completion.chunk', created,
        model: ollamaReq.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      });
    }

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
        lastChunk = chunk;
        const content = chunk.message?.content ?? '';
        if (content) totalContentLen += content.length;
        const finishReason = chunk.done ? (chunk.done_reason || 'stop') : null;

        // Empty-response detector: if Ollama is sending us done=true with
        // zero content tokens, that's almost always an account issue
        // (invalid key / out of credits / model not entitled). Synthesize a
        // diagnostic message into the stream BEFORE the [DONE] marker so
        // the user sees a clear explanation instead of silent emptiness.
        if (chunk.done && totalContentLen === 0) {
          const diag = [
            '⚠️ Ollama Cloud returned an empty response.',
            '',
            'Most common causes:',
            `• Your **OLLAMA_API_KEY** on Railway is invalid or expired`,
            `• Your **Ollama Cloud account is out of credits** — check https://ollama.com/settings`,
            `• Model "${ollamaReq.model}" isn't available to your account/plan`,
            `• Ollama Cloud is rate-limiting or down`,
            '',
            `**Diagnostic:** upstream HTTP ${upstream.status}, response chunks: ${chunk.eval_count ?? 0} tokens, model echoed: ${chunk.model || '(none)'}.`,
            '',
            'Fix: rotate the key at https://ollama.com/settings/keys, paste the new value into Railway → Variables → OLLAMA_API_KEY, then send again.',
          ].join('\n');
          writeSyntheticContent(diag);
        }

        writeSse({
          id: idStr, object: 'chat.completion.chunk', created,
          model: chunk.model || ollamaReq.model,
          choices: [{
            index: 0,
            delta: chunk.done ? {} : { role: 'assistant', content },
            finish_reason: finishReason,
          }],
        });
        if (chunk.done) { res.write('data: [DONE]\n\n'); sentDone = true; }
      }
    }
    // If the upstream closed without ever sending done=true, emit a
    // diagnostic so the client doesn't hang silently.
    if (!sentDone) {
      writeSyntheticContent(`⚠️ Upstream closed without completing. Last chunk: ${lastChunk ? JSON.stringify(lastChunk).slice(0, 200) : '(none)'}`);
      writeSse({ id: idStr, object: 'chat.completion.chunk', created, model: ollamaReq.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'error' }] });
      res.write('data: [DONE]\n\n');
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

function checkAuth(req, res) {
  if (!AUTH_ENABLED) return true;
  const got = req.headers.authorization || '';
  // timingSafeEqual requires equal-length buffers; pad and compare via length first
  if (got.length !== EXPECTED_AUTH.length || got !== EXPECTED_AUTH) {
    res.writeHead(401, {
      'www-authenticate': 'Basic realm="claw", charset="UTF-8"',
      'content-type': 'text/plain',
    });
    res.end('authentication required');
    return false;
  }
  return true;
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (!checkAuth(req, res)) return;
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

/* ------------------------------------------------------------------
 * Bridge relay — pairing between local executors and the web chat.
 * Three roles connect to /ws with the same `token` query param:
 *   role=extension  → Chrome extension (browser tab control)
 *   role=desktop    → native helper (mouse, keyboard, screenshot)
 *   role=client     → the chat UI in the browser
 * Messages flow: client → executor (by command.target), executor → client.
 * Tokens are generated client-side and only ever live in memory here. */
const pairs = new Map(); // token -> { extension, desktop, clients: Set<ws> }

function getOrCreatePair(token) {
  let pair = pairs.get(token);
  if (!pair) {
    pair = { extension: null, desktop: null, clients: new Set() };
    pairs.set(token, pair);
  }
  return pair;
}

function bridgeStatusFor(pair) {
  return {
    extension: pair.extension && pair.extension.readyState === 1 ? 'connected' : 'disconnected',
    desktop: pair.desktop && pair.desktop.readyState === 1 ? 'connected' : 'disconnected',
  };
}

function broadcastBridgeStatus(token) {
  const pair = pairs.get(token);
  if (!pair) return;
  const status = bridgeStatusFor(pair);
  const msg = JSON.stringify({
    type: 'bridge_status',
    // Back-compat: old clients only know about the single `state` field, which
    // we keep meaning "extension state". New clients use `executors`.
    state: status.extension,
    executors: status,
  });
  for (const client of pair.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws, req, ctx) => {
  const { role, token } = ctx;
  const pair = getOrCreatePair(token);

  if (role === 'extension' || role === 'desktop') {
    if (pair[role] && pair[role].readyState === 1) {
      try { pair[role].close(1008, 'replaced'); } catch { /* noop */ }
    }
    pair[role] = ws;
    broadcastBridgeStatus(token);
  } else {
    pair.clients.add(ws);
    const status = bridgeStatusFor(pair);
    ws.send(JSON.stringify({ type: 'bridge_status', state: status.extension, executors: status }));
  }

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (role === 'client' && (msg.type === 'command' || msg.type === 'control')) {
      // Route by target: 'desktop' → desktop helper, anything else → extension.
      const target = msg.target === 'desktop' ? 'desktop' : 'extension';
      const executor = pair[target];
      if (executor && executor.readyState === 1) {
        executor.send(JSON.stringify(msg));
      } else if (msg.type === 'command') {
        ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: `${target} not connected` }));
      }
    } else if ((role === 'extension' || role === 'desktop') && msg.type === 'result') {
      // forward result to all clients (they filter by id)
      for (const client of pair.clients) {
        if (client.readyState === 1) client.send(JSON.stringify(msg));
      }
    }
  });

  ws.on('close', () => {
    if (role === 'extension' || role === 'desktop') {
      if (pair[role] === ws) pair[role] = null;
      broadcastBridgeStatus(token);
    } else {
      pair.clients.delete(ws);
    }
    if (!pair.extension && !pair.desktop && pair.clients.size === 0) pairs.delete(token);
  });
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  // Basic auth applies to the WS handshake too when enabled.
  if (AUTH_ENABLED) {
    const got = req.headers.authorization || '';
    if (got !== EXPECTED_AUTH) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="claw"\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  const url = new URL(req.url, 'http://x');
  const role = url.searchParams.get('role');
  const token = url.searchParams.get('token');
  if (role !== 'extension' && role !== 'client' && role !== 'desktop') {
    socket.destroy();
    return;
  }
  if (!token || token.length < 8 || token.length > 128) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, { role, token });
  });
});

server.listen(PORT, () => {
  console.log(`claw-code web listening on :${PORT}`);
  console.log(`upstream ollama: ${OLLAMA_URL}`);
  console.log(`api key: ${OLLAMA_API_KEY ? 'set' : 'MISSING — set OLLAMA_API_KEY'}`);
  console.log(`basic auth: ${AUTH_ENABLED ? `ENABLED (user=${BASIC_AUTH_USER})` : 'disabled'}`);
  console.log(`bridge relay: ws(s)://<host>/ws?role=...&token=...`);
});
