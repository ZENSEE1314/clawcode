/* Claw browser bridge — service worker.
 * Maintains a WebSocket to the configured relay, executes commands on the
 * active tab, and ships results back. State persists across SW restarts via
 * chrome.storage.local because MV3 service workers idle out aggressively. */

const DEFAULT_RELAY = 'wss://clawcode-production.up.railway.app/ws';
let socket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

async function getConfig() {
  const cfg = await chrome.storage.local.get(['relay', 'token']);
  return {
    relay: cfg.relay || DEFAULT_RELAY,
    token: cfg.token || '',
  };
}

async function setStatus(state, detail = '') {
  await chrome.storage.local.set({ status: { state, detail, at: Date.now() } });
  try {
    await chrome.runtime.sendMessage({ type: 'status', state, detail });
  } catch {
    /* popup may be closed */
  }
}

async function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  const { relay, token } = await getConfig();
  if (!token) {
    await setStatus('idle', 'no token configured');
    return;
  }
  await setStatus('connecting', relay);
  try {
    socket = new WebSocket(`${relay}?role=extension&token=${encodeURIComponent(token)}`);
  } catch (err) {
    scheduleReconnect();
    return;
  }
  socket.addEventListener('open', () => {
    reconnectAttempts = 0;
    setStatus('connected', relay);
  });
  socket.addEventListener('message', async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type !== 'command') return;
    const result = await executeCommand(msg);
    socket.send(JSON.stringify({ type: 'result', id: msg.id, ...result }));
  });
  socket.addEventListener('close', () => {
    setStatus('disconnected');
    scheduleReconnect();
  });
  socket.addEventListener('error', () => {
    try { socket.close(); } catch { /* noop */ }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempts++;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempts, 5));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function executeCommand(msg) {
  const { action, params = {} } = msg;
  try {
    const tab = await getActiveTab();
    if (!tab && action !== 'navigate') return { ok: false, error: 'no active tab' };
    switch (action) {
      case 'screenshot': {
        const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'jpeg', quality: 70 });
        return { ok: true, data: { dataUrl, url: tab.url, title: tab.title } };
      }
      case 'navigate': {
        if (!params.url) return { ok: false, error: 'url required' };
        const updated = await chrome.tabs.update(tab.id, { url: params.url });
        return { ok: true, data: { url: updated.url } };
      }
      case 'click': {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (selector, x, y) => {
            if (selector) {
              const el = document.querySelector(selector);
              if (!el) return { ok: false, error: `selector not found: ${selector}` };
              el.click();
              return { ok: true };
            }
            if (typeof x === 'number' && typeof y === 'number') {
              const el = document.elementFromPoint(x, y);
              if (!el) return { ok: false, error: `no element at ${x},${y}` };
              el.click();
              return { ok: true, tag: el.tagName };
            }
            return { ok: false, error: 'click needs selector or x/y' };
          },
          args: [params.selector || '', params.x ?? null, params.y ?? null],
        });
        return result;
      }
      case 'type': {
        if (typeof params.text !== 'string') return { ok: false, error: 'text required' };
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (selector, text) => {
            const el = selector ? document.querySelector(selector) : document.activeElement;
            if (!el) return { ok: false, error: 'no input element' };
            el.focus();
            const tag = el.tagName.toLowerCase();
            if (tag === 'input' || tag === 'textarea') {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
              setter?.call(el, text);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true };
            }
            if (el.isContentEditable) {
              el.textContent = text;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              return { ok: true };
            }
            return { ok: false, error: `cannot type into <${tag}>` };
          },
          args: [params.selector || '', params.text],
        });
        return result;
      }
      case 'read_page': {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({
            url: location.href,
            title: document.title,
            text: document.body.innerText.slice(0, 8000),
          }),
        });
        return { ok: true, data: result };
      }
      case 'find': {
        if (!params.query) return { ok: false, error: 'query required' };
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (q) => {
            const ql = q.toLowerCase();
            const nodes = Array.from(document.querySelectorAll('a, button, input, textarea, [role="button"], [role="link"]'));
            const matches = nodes
              .map(el => {
                const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim();
                return { el, text, score: text.toLowerCase().includes(ql) ? text.length : 0 };
              })
              .filter(m => m.score > 0)
              .sort((a, b) => a.score - b.score)
              .slice(0, 10)
              .map((m, i) => {
                const r = m.el.getBoundingClientRect();
                m.el.setAttribute('data-claw-ref', `claw_${i}`);
                return { ref: `claw_${i}`, text: m.text.slice(0, 80), tag: m.el.tagName, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
              });
            return matches;
          },
          args: [params.query],
        });
        return { ok: true, data: result };
      }
      case 'scroll': {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (dir, amount) => {
            const px = (amount || 3) * 200;
            const dy = dir === 'up' ? -px : dir === 'down' ? px : 0;
            const dx = dir === 'left' ? -px : dir === 'right' ? px : 0;
            window.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
            return { ok: true, scrollY: window.scrollY };
          },
          args: [params.direction || 'down', params.amount || 3],
        });
        return result;
      }
      default:
        return { ok: false, error: `unknown action: ${action}` };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'reconnect') {
    if (socket) try { socket.close(); } catch { /* noop */ }
    connect();
    sendResponse({ ok: true });
  }
  return true;
});

connect();
