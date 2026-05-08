/* claw desktop helper — Windows.
 *
 * Pairs with the claw-code web app via the /ws relay (same token as the
 * Chrome extension). Receives JSON commands and executes them locally.
 *
 * Capabilities (intentionally minimal for v1):
 *   screenshot, mouse_move, mouse_click, mouse_double_click,
 *   key_type, key_combo, screen_size, open_app
 *
 * Explicit non-capabilities: shell exec, file read, file write.
 * Add them later only with confirmation prompts.
 *
 * Implementation: spawns PowerShell for each action — no native deps,
 * works on stock Windows. ~200ms latency per command.
 */

import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const CONFIG_PATH = join(homedir(), '.claw-desktop-helper.json');
const DEFAULT_RELAY = 'wss://clawcode-production.up.railway.app/ws';

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}
function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

const cfg = loadConfig();
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const relay = args.relay || cfg.relay || DEFAULT_RELAY;
let token = args.token || cfg.token;

if (!token) {
  console.error('\n  no token configured.');
  console.error('  pass one with: node helper.js --token=YOUR_TOKEN');
  console.error('  get the token from the web app: Console → Browser tab → "Pairing token"\n');
  process.exit(1);
}

if (args.token || args.relay) {
  saveConfig({ relay, token });
  console.log(`saved config to ${CONFIG_PATH}`);
}

console.log(`\n  ┌─────────────────────────────────────────`);
console.log(`  │ claw desktop helper`);
console.log(`  │ relay: ${relay}`);
console.log(`  │ token: ${token.slice(0, 8)}…${token.slice(-4)}`);
console.log(`  └─────────────────────────────────────────\n`);

/* ----------------------- PowerShell bridge ------------------------ */

function runPowerShell(script, opts = {}) {
  return new Promise((resolveP, rejectP) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], { windowsHide: true });
    let stdout = '', stderr = '';
    ps.stdout.on('data', d => stdout += d.toString());
    ps.stderr.on('data', d => stderr += d.toString());
    ps.on('close', code => {
      if (code !== 0) rejectP(new Error(stderr.trim() || `powershell exit ${code}`));
      else resolveP(stdout.trim());
    });
    if (opts.timeout) setTimeout(() => { try { ps.kill(); } catch { /* noop */ } rejectP(new Error('timeout')); }, opts.timeout);
  });
}

/* ----------------------- action implementations ------------------- */

async function screenSize() {
  const out = await runPowerShell(`
    Add-Type -AssemblyName System.Windows.Forms
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    "$($b.Width),$($b.Height)"
  `);
  const [w, h] = out.split(',').map(Number);
  return { width: w, height: h };
}

async function mouseMove(x, y) {
  await runPowerShell(`
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x | 0}, ${y | 0})
  `);
  return { ok: true, x: x | 0, y: y | 0 };
}

const MOUSE_EVENT_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseClicker {
  [DllImport("user32.dll", CharSet = CharSet.Auto, CallingConvention = CallingConvention.StdCall)]
  public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@`;

async function mouseClick(x, y, button = 'left') {
  const downFlag = button === 'right' ? 0x0008 : button === 'middle' ? 0x0020 : 0x0002;
  const upFlag   = button === 'right' ? 0x0010 : button === 'middle' ? 0x0040 : 0x0004;
  await runPowerShell(`
    ${MOUSE_EVENT_SCRIPT}
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x | 0}, ${y | 0})
    Start-Sleep -Milliseconds 60
    [MouseClicker]::mouse_event(${downFlag}, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 30
    [MouseClicker]::mouse_event(${upFlag}, 0, 0, 0, [UIntPtr]::Zero)
  `);
  return { ok: true };
}

async function mouseDoubleClick(x, y) {
  await mouseClick(x, y);
  await new Promise(r => setTimeout(r, 80));
  await mouseClick(x, y);
  return { ok: true };
}

function escapeForSendKeys(text) {
  // SendKeys reserves: + ^ % ~ ( ) { } [ ]
  return text.replace(/[+^%~(){}[\]]/g, ch => `{${ch}}`);
}

async function keyType(text) {
  if (typeof text !== 'string') throw new Error('text required');
  // SendWait can struggle with long strings; chunk every 200 chars
  const chunks = text.match(/.{1,200}/gs) || [text];
  for (const chunk of chunks) {
    const escaped = escapeForSendKeys(chunk);
    await runPowerShell(`
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait('${escaped.replace(/'/g, "''")}')
    `);
  }
  return { ok: true, length: text.length };
}

const COMBO_KEY_MAP = {
  enter: '{ENTER}', return: '{ENTER}',
  tab: '{TAB}', escape: '{ESC}', esc: '{ESC}',
  backspace: '{BS}', delete: '{DEL}', del: '{DEL}', insert: '{INS}',
  home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  space: ' ',
  f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
  f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}',
};

async function keyCombo(combo) {
  // Examples: "ctrl+c", "alt+tab", "win+l", "ctrl+shift+t"
  if (typeof combo !== 'string') throw new Error('combo string required');
  const parts = combo.toLowerCase().split('+').map(s => s.trim());
  const mods = { ctrl: '^', alt: '%', shift: '+' };
  let prefix = '';
  let key = '';
  for (const p of parts) {
    if (mods[p]) prefix += mods[p];
    else if (p === 'win' || p === 'meta' || p === 'cmd') {
      // SendKeys has no Windows-key support; fall back to powershell+user32
      throw new Error('windows-key combos not supported by SendKeys; ask for a different combo');
    } else key = p;
  }
  if (!key) throw new Error('combo must include a non-modifier key');
  const mapped = COMBO_KEY_MAP[key] || (key.length === 1 ? key : `{${key.toUpperCase()}}`);
  await runPowerShell(`
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait('${(prefix + mapped).replace(/'/g, "''")}')
  `);
  return { ok: true, combo };
}

async function screenshot() {
  const file = join(tmpdir(), `claw-shot-${randomBytes(4).toString('hex')}.png`);
  await runPowerShell(`
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save('${file.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
  `, { timeout: 15000 });
  const data = readFileSync(file);
  try { require('node:fs').unlinkSync(file); } catch { /* noop */ }
  return {
    ok: true,
    data: { dataUrl: `data:image/png;base64,${data.toString('base64')}` },
  };
}

async function openApp(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9 _.\-]+$/.test(name)) {
    throw new Error('app name must be alphanumeric (e.g. "notepad", "chrome")');
  }
  await runPowerShell(`Start-Process '${name}'`);
  return { ok: true, app: name };
}

/* ----------------------- command dispatcher ----------------------- */

async function executeCommand(msg) {
  const { action, params = {} } = msg;
  try {
    switch (action) {
      case 'screen_size':       return { ok: true, data: await screenSize() };
      case 'mouse_move':        return { ...(await mouseMove(params.x, params.y)) };
      case 'mouse_click':       return { ...(await mouseClick(params.x, params.y, params.button)) };
      case 'mouse_double_click':return { ...(await mouseDoubleClick(params.x, params.y)) };
      case 'key_type':          return { ...(await keyType(params.text)) };
      case 'key_combo':         return { ...(await keyCombo(params.combo)) };
      case 'screenshot':        return await screenshot();
      case 'open_app':          return { ...(await openApp(params.name)) };
      default: return { ok: false, error: `unknown desktop action: ${action}` };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ----------------------- WebSocket loop --------------------------- */

let socket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

function connect() {
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
  const url = `${relay}?role=desktop&token=${encodeURIComponent(token)}`;
  console.log(`connecting…`);
  socket = new WebSocket(url);

  socket.on('open', () => {
    reconnectAttempts = 0;
    console.log(`✓ connected`);
  });
  socket.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type !== 'command') return;
    console.log(`→ ${msg.action} ${JSON.stringify(msg.params || {}).slice(0, 80)}`);
    const result = await executeCommand(msg);
    if (socket.readyState === 1) {
      socket.send(JSON.stringify({ type: 'result', id: msg.id, ...result }));
    }
    console.log(`← ${result.ok ? 'ok' : 'err: ' + result.error}`);
  });
  socket.on('close', (code) => {
    console.log(`× disconnected (${code})`);
    scheduleReconnect();
  });
  socket.on('error', (err) => {
    console.log(`! ${err.message}`);
    try { socket.close(); } catch { /* noop */ }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempts++;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempts, 5));
  console.log(`  reconnect in ${(delay / 1000).toFixed(0)}s`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

connect();

process.on('SIGINT', () => {
  console.log('\nshutting down.');
  try { socket?.close(); } catch { /* noop */ }
  process.exit(0);
});
