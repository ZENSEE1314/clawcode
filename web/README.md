# claw-code web

Browser UI for chatting with Ollama Cloud models (`gemma3:27b-cloud`, etc.) from anywhere.
Static UI + thin Node proxy that holds your Ollama API key server-side.

## Architecture

```
Browser ──▶ Node server (this repo) ──▶ Ollama Cloud (https://ollama.com)
                 │
                 └── serves index.html
                 └── proxies POST /v1/chat/completions with Authorization: Bearer <OLLAMA_API_KEY>
```

The browser never sees the API key. Streaming SSE is forwarded through.

## Deploy to Railway

1. Push this repo to GitHub.
2. [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo** → pick this repo.
3. **Settings → Root Directory** → set to `web`.
4. **Variables** tab → add:
   - `OLLAMA_API_KEY` = your key from <https://ollama.com/settings/keys>
   - (optional) `OLLAMA_URL` = `https://ollama.com` (default)
5. **Settings → Networking → Generate Domain**.
6. Open the generated URL. Done — works on any device.

`railway.json` already points the start command at `node server.js` and exposes `/healthz`.

## Run locally

```bash
cd web
export OLLAMA_API_KEY=your-key-here
npm start
# open http://localhost:3000
```

To skip the proxy and hit a local `ollama serve` directly, run with:

```bash
OLLAMA_URL=http://127.0.0.1:11434 npm start
```

## Endpoints

| Path | Purpose |
|---|---|
| `GET /` | serves `index.html` |
| `GET /healthz` | Railway healthcheck |
| `POST /v1/chat/completions` | proxied to `${OLLAMA_URL}/v1/chat/completions` with bearer auth |
| `POST /api/share` | snapshot the current conversation, returns a public URL |
| `GET /s/:id` | renders a shared conversation as plain HTML (NotebookLM-ingestible) |

## Integrations

### Obsidian

Two modes — both live in the right-panel **Integrations** tab:

- **URI scheme** (default, no setup): clicks fire `obsidian://new` URLs. Only works when you're browsing on the same machine where Obsidian is installed.
- **Local REST API** (silent append, recommended): install the [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api), copy the API key from its settings, paste it into the integration card under "Local REST API" along with the URL (default `https://127.0.0.1:27124`). The browser POSTs directly to your local Obsidian — Railway is not in the path. For the self-signed HTTPS cert, visit the URL once in your browser and accept it.

### NotebookLM

NotebookLM has no public API. The "Share conversation → open NotebookLM" button:
1. POSTs the current chat to `/api/share` on your Railway server
2. Server stores it in memory and returns a public URL like `https://your-app.up.railway.app/s/abc123`
3. Browser copies the URL, opens NotebookLM
4. You paste the URL into NotebookLM as a **Web** source — NotebookLM fetches and ingests it

Shares are in-memory (lost on restart) with a 30-day TTL and 500-share cap. For persistence, mount a Railway volume and swap the `Map` in `server.js` for fs-backed JSON.

## Models

The UI defaults to `gemma3:27b-cloud`. You can switch from the model dropdown.
Any Ollama Cloud model name works — just type it in.

## Security notes

- API key is **server-side only**. Never exposed to the browser.
- **Optional HTTP Basic Auth**: set both `BASIC_AUTH_USER` and `BASIC_AUTH_PASS` in Railway → Variables to lock the app behind a browser login prompt. Leaving either unset disables auth (default). The `/healthz` endpoint always bypasses auth so Railway's probe keeps working.
- CORS is same-origin only (no cross-origin headers set).

For stronger access control, put the Railway URL behind Cloudflare Access or a similar identity-aware proxy.
