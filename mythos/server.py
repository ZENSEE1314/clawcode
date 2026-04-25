"""OpenMythos sidecar — minimal HTTP wrapper around the OpenMythos
recurrent-depth transformer architecture.

WARNING: this serves an UNTRAINED model. Output will be statistical noise
(uniformly random tokens). To get useful text out of OpenMythos you need
to train it on a real corpus, which requires GPUs and days/weeks of
compute. This sidecar exists so you can verify the architecture loads
and runs, not to provide chat responses.

Endpoints:
    GET  /healthz             liveness probe
    GET  /info                model config + parameter count
    POST /generate            { "tokens": [int...], "n_loops": int }
                              -> { "logits_shape": [...], "next_token": int }
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# OpenMythos config: keep tiny so CPU inference stays sub-second
VOCAB_SIZE = 32_000
DIM = 256
N_LOOPS_DEFAULT = 4

logger = logging.getLogger("mythos")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

state: dict = {"model": None, "config": None, "device": "cpu"}


def build_model():
    """Construct an untrained OpenMythos model with a small config."""
    from open_mythos.main import MythosConfig, OpenMythos  # type: ignore

    cfg = MythosConfig(
        vocab_size=VOCAB_SIZE,
        dim=DIM,
        n_layers_prelude=2,
        n_layers_recurrent=2,
        n_layers_coda=2,
        n_heads=4,
        attention_type="gqa",
    )
    model = OpenMythos(cfg)
    model.eval()
    n_params = sum(p.numel() for p in model.parameters())
    logger.info("OpenMythos built: %s params, dim=%d, vocab=%d", f"{n_params:,}", DIM, VOCAB_SIZE)
    return cfg, model, n_params


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg, model, n_params = build_model()
    state["model"] = model
    state["config"] = {"vocab_size": cfg.vocab_size, "dim": cfg.dim, "n_params": n_params}
    yield
    state.clear()


app = FastAPI(title="open-mythos sidecar", lifespan=lifespan)


@app.get("/healthz")
def healthz():
    return {"status": "ok", "model_loaded": state.get("model") is not None}


@app.get("/info")
def info():
    return {
        **state.get("config", {}),
        "warning": "untrained model — outputs are random",
    }


class GenerateRequest(BaseModel):
    tokens: list[int]
    n_loops: int | None = None


@app.post("/generate")
def generate(req: GenerateRequest):
    model = state.get("model")
    if model is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    if not req.tokens:
        raise HTTPException(status_code=400, detail="tokens must be non-empty")
    if any(t < 0 or t >= VOCAB_SIZE for t in req.tokens):
        raise HTTPException(status_code=400, detail=f"token ids must be in [0, {VOCAB_SIZE})")
    n_loops = req.n_loops or N_LOOPS_DEFAULT
    if n_loops < 1 or n_loops > 16:
        raise HTTPException(status_code=400, detail="n_loops must be in [1, 16]")

    ids = torch.tensor([req.tokens], dtype=torch.long)
    with torch.no_grad():
        logits = model(ids, n_loops=n_loops)
    next_token = int(torch.argmax(logits[0, -1]).item())
    return {
        "logits_shape": list(logits.shape),
        "next_token": next_token,
        "n_loops": n_loops,
        "warning": "untrained model — next_token is essentially random",
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("server:app", host="0.0.0.0", port=port, log_level="info")
