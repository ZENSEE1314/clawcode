const DEFAULT_RELAY = 'wss://clawcode-production.up.railway.app/ws';

const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const relayInput = document.getElementById('relay');
const tokenInput = document.getElementById('token');

function paint(state, detail) {
  dot.className = 'dot ' + state;
  statusText.textContent = state + (detail ? ` — ${detail}` : '');
}

async function load() {
  const cfg = await chrome.storage.local.get(['relay', 'token', 'status']);
  relayInput.value = cfg.relay || DEFAULT_RELAY;
  tokenInput.value = cfg.token || '';
  if (cfg.status) paint(cfg.status.state, cfg.status.detail);
}

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    relay: relayInput.value.trim() || DEFAULT_RELAY,
    token: tokenInput.value.trim(),
  });
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  paint('connecting', 'reconnecting…');
});

document.getElementById('reconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  paint('connecting', 'reconnecting…');
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'status') paint(msg.state, msg.detail);
});

load();
