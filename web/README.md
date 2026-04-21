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

## Models

The UI defaults to `gemma3:27b-cloud`. You can switch from the model dropdown.
Any Ollama Cloud model name works — just type it in.

## Security notes

- API key is **server-side only**. Never exposed to the browser.
- No auth on the proxy itself — anyone with the Railway URL can use your key. Add basic auth or put it behind Cloudflare Access if that matters to you.
- CORS is same-origin only (no cross-origin headers set).
