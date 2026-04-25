# OpenMythos sidecar

A minimal Python HTTP wrapper around [kyegomez/OpenMythos](https://github.com/kyegomez/OpenMythos),
deployed as a separate Railway service alongside the claw-code web app.

## What this actually is

OpenMythos is a **PyTorch implementation of a transformer architecture** (the
"Recurrent-Depth Transformer" with prelude → recurrent block → coda stages).
It is **not** a pretrained chat model. The repo ships zero weights.

This sidecar:
- Builds an OpenMythos model with a tiny config (vocab 32k, dim 256, ~few-million params)
- Loads it **untrained** — every weight is randomly initialized
- Exposes three HTTP endpoints so you can verify the architecture runs

## What you get from this

- A working FastAPI service that proves the OpenMythos package installs and runs on Railway
- An `/info` endpoint showing parameter count and config
- A `/generate` endpoint that accepts token IDs and returns the next predicted token

**The next-token output is random.** No training = no learned distribution = uniform-noise predictions. Do not wire this into the chat UI expecting useful replies.

## To make this useful

You'd need to:

1. Get a corpus (HuggingFace datasets, your own data, etc.)
2. Train the model — days to weeks of GPU compute
3. Save weights, load them at startup in `server.py`
4. Add a tokenizer (BPE/SentencePiece) so you can map between text and token IDs
5. Add a sampling loop (top-k / top-p) instead of `argmax`

That's a months-long project. If you want a working chat AI, use Ollama Cloud
models (already wired into the main web app) or call Anthropic / OpenAI APIs.

## Deploy

Already pushed to the same GitHub repo. To deploy:

1. Railway → **New Service in this project** → **Deploy from GitHub repo** → pick `ZENSEE1314/clawcode`
2. **Settings → Source → Root Directory** = `mythos`
3. **Settings → Source → Branch** = `web-ui`
4. Generate a domain.
5. Hit `https://<your-mythos-url>/info` to see the model config.

Build will take **5-10 minutes** the first time because PyTorch is a heavy
install (~1GB). Cold starts after that are ~30s while the model initializes.

## Endpoints

```bash
# Liveness
GET /healthz
→ { "status": "ok", "model_loaded": true }

# Model info
GET /info
→ { "vocab_size": 32000, "dim": 256, "n_params": 4123456,
    "warning": "untrained model — outputs are random" }

# Predict next token (untrained — output is random)
POST /generate
Content-Type: application/json
{ "tokens": [12, 84, 215, 9], "n_loops": 4 }
→ { "logits_shape": [1, 4, 32000], "next_token": 17234,
    "n_loops": 4, "warning": "untrained model — ..." }
```

## Local run

```bash
cd mythos
python -m venv .venv && source .venv/bin/activate    # on Windows: .venv\Scripts\activate
pip install -r requirements.txt
python server.py
# → http://localhost:8000/info
```
