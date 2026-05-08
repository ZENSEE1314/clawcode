/* claw desktop helper — Windows.
 *
 * Pairs with the claw-code web app via the /ws relay (same token as the
 * Chrome extension). Receives JSON commands and executes them locally.
 *
 * SAFETY MODEL
 * ─────────────
 * Capability categories must be explicitly opted into at startup:
 *   --allow=shell        → shell command execution
 *   --allow=fs           → file read/write/delete, list_dir
 *   --allow=registry     → registry read/write
 *   --allow=services     → list/start/stop/restart Windows services
 * (Combine with commas: --allow=shell,fs)
 *
 * Without --yolo, every WRITE/DESTRUCTIVE command pops a y/N prompt in
 * THIS terminal window. You see exactly what the model wants to do and
 * approve or deny. No prompt → no execution.
 *
 * --yolo skips the per-command prompts. Only use it when you actively
 * want to let the model rip and you accept the consequences.
 *
 * READ-ONLY commands inside an enabled category never prompt.
 *
 * Always-on commands (no --allow needed):
 *   screenshot, screen_size, mouse_*, key_type, key_combo, open_app
 */

import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import * as pw from './playwright-runner.js';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync,
  readdirSync, statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, isAbsolute, resolve as pathResolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

const CONFIG_PATH = join(homedir(), '.claw-desktop-helper.json');
const DEFAULT_RELAY = 'wss://clawcode-production.up.railway.app/ws';
const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;            // 5 MB cap on read/write
const CONFIRM_TIMEOUT_MS = 60_000;

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
const yolo = !!args.yolo;
const allow = new Set(
  String(args.allow || '').split(',').map(s => s.trim()).filter(Boolean)
);

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
console.log(`  │ relay  : ${relay}`);
console.log(`  │ token  : ${token.slice(0, 8)}…${token.slice(-4)}`);
console.log(`  │ allow  : ${allow.size ? [...allow].join(', ') : '(none — only mouse/keyboard/screenshot)'}`);
console.log(`  │ confirm: ${yolo ? 'OFF (--yolo)  ⚠ BE CAREFUL' : 'ON (per-command y/N prompt)'}`);
console.log(`  └─────────────────────────────────────────\n`);

if (yolo && allow.size) {
  console.log('⚠ YOLO MODE: destructive commands run without confirmation.');
  console.log('  Hit Ctrl+C to revoke control instantly.\n');
}

/* ----------------------- confirmation prompt --------------------- */

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let confirmQueue = Promise.resolve();

// Runtime auto-approve flags — togglable from the web UI via control msg.
// Each entry covers all "mutating" commands in that category. Read-only
// commands (read_file, list_dir, registry_read, service_list/_status) are
// unaffected; they always run without prompts. Defaults: all OFF.
const autoApprove = { shell: false, fs: false, registry: false, services: false, playwright: false, gbrain: false };

pw.setDefaults({ headless: !!args['playwright-headless'] });

function setAutoApprove(values) {
  if (!values || typeof values !== 'object') return;
  let changed = [];
  for (const k of Object.keys(autoApprove)) {
    if (typeof values[k] === 'boolean' && values[k] !== autoApprove[k]) {
      autoApprove[k] = values[k];
      changed.push(`${k}=${values[k] ? 'ON' : 'off'}`);
    }
  }
  if (changed.length) console.log(`⚙ auto-approve updated: ${changed.join(', ')}`);
}

function confirmAction(category, label, details) {
  if (yolo) return Promise.resolve(true);
  if (autoApprove[category]) {
    console.log(`✓ auto-approved (${category}): ${label}`);
    return Promise.resolve(true);
  }
  // Serialise prompts so multiple commands queue up cleanly.
  confirmQueue = confirmQueue.then(() => new Promise(resolveP => {
    console.log('\n──────── confirm ────────');
    console.log(`  ${label}`);
    for (const [k, v] of Object.entries(details || {})) {
      const shown = String(v).length > 200 ? String(v).slice(0, 200) + '…' : v;
      console.log(`  ${k.padEnd(8)}: ${shown}`);
    }
    console.log(`  (auto-approve ${category} from web UI to skip these)`);
    let timer = setTimeout(() => {
      console.log('  → timed out, denied.');
      resolveP(false);
    }, CONFIRM_TIMEOUT_MS);
    rl.question('allow? [y/N]: ', (answer) => {
      clearTimeout(timer);
      const ok = /^y(es)?$/i.test(answer.trim());
      console.log(`  → ${ok ? 'allowed' : 'denied'}`);
      resolveP(ok);
    });
  }));
  return confirmQueue;
}

function requireAllow(category) {
  if (!allow.has(category)) {
    throw new Error(`category "${category}" not enabled — restart helper with --allow=${category}`);
  }
}

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

/* ----------------------- mouse / keyboard / screenshot ----------- */

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
  return text.replace(/[+^%~(){}[\]]/g, ch => `{${ch}}`);
}

async function keyType(text) {
  if (typeof text !== 'string') throw new Error('text required');
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
  if (typeof combo !== 'string') throw new Error('combo string required');
  const parts = combo.toLowerCase().split('+').map(s => s.trim());
  const mods = { ctrl: '^', alt: '%', shift: '+' };
  let prefix = '';
  let key = '';
  for (const p of parts) {
    if (mods[p]) prefix += mods[p];
    else if (p === 'win' || p === 'meta' || p === 'cmd') {
      throw new Error('windows-key combos not supported by SendKeys');
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
  try { unlinkSync(file); } catch { /* noop */ }
  return { ok: true, data: { dataUrl: `data:image/png;base64,${data.toString('base64')}` } };
}

async function openApp(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9 _.\-]+$/.test(name)) {
    throw new Error('app name must be alphanumeric (e.g. "notepad", "chrome")');
  }
  await runPowerShell(`Start-Process '${name}'`);
  return { ok: true, app: name };
}

/* ----------------------- shell ----------------------------------- */

async function shellExec(command, opts = {}) {
  requireAllow('shell');
  if (typeof command !== 'string' || !command.trim()) throw new Error('command required');
  const cwd = opts.cwd && typeof opts.cwd === 'string' ? opts.cwd : process.cwd();
  const ok = await confirmAction('shell', 'shell command', { command, cwd });
  if (!ok) return { ok: false, error: 'denied by user' };
  const timeout = Math.min(opts.timeout || DEFAULT_SHELL_TIMEOUT_MS, 5 * 60_000);
  // Run via PowerShell so the model can use any PS or native command.
  const out = await new Promise((resolveP) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', command,
    ], { cwd, windowsHide: true });
    let stdout = '', stderr = '';
    ps.stdout.on('data', d => stdout += d.toString());
    ps.stderr.on('data', d => stderr += d.toString());
    const timer = setTimeout(() => { try { ps.kill(); } catch { /* noop */ } }, timeout);
    ps.on('close', code => {
      clearTimeout(timer);
      resolveP({ exitCode: code, stdout: stdout.slice(0, 16_000), stderr: stderr.slice(0, 8_000) });
    });
  });
  return { ok: out.exitCode === 0, data: out };
}

/* ----------------------- filesystem ------------------------------ */

function safePath(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('path required');
  if (!isAbsolute(p)) p = pathResolve(p);
  return p;
}

async function readFile(path) {
  requireAllow('fs');
  const p = safePath(path);
  const st = statSync(p);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > MAX_FILE_BYTES) throw new Error(`file > ${MAX_FILE_BYTES} bytes`);
  const data = readFileSync(p, 'utf8');
  return { ok: true, data: { path: p, bytes: st.size, content: data } };
}

async function writeFile(path, content, append = false) {
  requireAllow('fs');
  const p = safePath(path);
  if (typeof content !== 'string') throw new Error('content must be a string');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`content > ${MAX_FILE_BYTES} bytes`);
  const exists = existsSync(p);
  const ok = await confirmAction('fs', append ? 'append to file' : (exists ? 'OVERWRITE existing file' : 'create file'), {
    path: p,
    bytes: Buffer.byteLength(content, 'utf8'),
    preview: content.slice(0, 200),
  });
  if (!ok) return { ok: false, error: 'denied by user' };
  mkdirSync(dirname(p), { recursive: true });
  if (append) writeFileSync(p, (existsSync(p) ? readFileSync(p, 'utf8') : '') + content, 'utf8');
  else writeFileSync(p, content, 'utf8');
  return { ok: true, data: { path: p, bytes: Buffer.byteLength(content, 'utf8') } };
}

async function deleteFile(path) {
  requireAllow('fs');
  const p = safePath(path);
  if (!existsSync(p)) return { ok: false, error: 'not found' };
  const st = statSync(p);
  if (!st.isFile()) throw new Error('not a file (delete_dir not supported — use shell rm if needed)');
  const ok = await confirmAction('fs', 'DELETE file', { path: p, bytes: st.size });
  if (!ok) return { ok: false, error: 'denied by user' };
  unlinkSync(p);
  return { ok: true };
}

async function listDir(path, depth = 1) {
  requireAllow('fs');
  const p = safePath(path);
  const st = statSync(p);
  if (!st.isDirectory()) throw new Error('not a directory');
  const entries = readdirSync(p, { withFileTypes: true }).slice(0, 500).map(e => ({
    name: e.name,
    type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
  }));
  return { ok: true, data: { path: p, entries } };
}

/* ----------------------- registry -------------------------------- */

const ALLOWED_HIVES = ['HKCU', 'HKLM', 'HKCR', 'HKU', 'HKCC'];

function validateRegPath(path) {
  if (typeof path !== 'string') throw new Error('path required');
  const hive = path.split(':')[0].toUpperCase();
  if (!ALLOWED_HIVES.includes(hive)) throw new Error(`hive must be one of ${ALLOWED_HIVES.join(', ')}`);
  return path;
}

async function registryRead(path, name) {
  requireAllow('registry');
  validateRegPath(path);
  const out = await runPowerShell(name
    ? `(Get-ItemProperty -Path '${path.replace(/'/g, "''")}' -Name '${String(name).replace(/'/g, "''")}').'${String(name).replace(/'/g, "''")}'`
    : `Get-Item -Path '${path.replace(/'/g, "''")}' | Select-Object -ExpandProperty Property`);
  return { ok: true, data: out };
}

async function registryWrite(path, name, value, type = 'String') {
  requireAllow('registry');
  validateRegPath(path);
  if (typeof name !== 'string' || !name) throw new Error('name required');
  const allowedTypes = ['String', 'ExpandString', 'DWord', 'QWord', 'Binary', 'MultiString'];
  if (!allowedTypes.includes(type)) throw new Error(`type must be one of ${allowedTypes.join(', ')}`);
  const ok = await confirmAction('registry', 'REGISTRY write', { path, name, value: String(value), type });
  if (!ok) return { ok: false, error: 'denied by user' };
  const valArg = type === 'DWord' || type === 'QWord' ? Number(value) : `'${String(value).replace(/'/g, "''")}'`;
  await runPowerShell(`
    if (-not (Test-Path '${path.replace(/'/g, "''")}')) { New-Item -Path '${path.replace(/'/g, "''")}' -Force | Out-Null }
    Set-ItemProperty -Path '${path.replace(/'/g, "''")}' -Name '${name.replace(/'/g, "''")}' -Value ${valArg} -Type ${type} -Force
  `);
  return { ok: true };
}

/* ----------------------- gbrain (semantic memory) ---------------- *
 * Wraps the gbrain CLI from https://github.com/garrytan/gbrain — runs
 * locally on the user's machine, persists pages + embeddings in PGLite.
 * Helper shells out to `gbrain <subcommand>` so we don't need to track
 * the HTTP shape. Install once with: bun install -g gbrain (or clone +
 * bun link) and run `gbrain init` before first use.
 */

function shellQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function gbrainCli(psCommand, opts = {}) {
  return new Promise((resolveP) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', psCommand,
    ], { cwd: opts.cwd || process.cwd(), windowsHide: true });
    let stdout = '', stderr = '';
    ps.stdout.on('data', d => stdout += d.toString());
    ps.stderr.on('data', d => stderr += d.toString());
    const timer = setTimeout(() => { try { ps.kill(); } catch { /* noop */ } }, opts.timeout || 60_000);
    ps.on('close', code => {
      clearTimeout(timer);
      const out = { exitCode: code, stdout: stdout.slice(0, 16_000), stderr: stderr.slice(0, 4_000) };
      if (code !== 0 && /not recognized|command not found/i.test(stderr)) {
        out.hint = 'gbrain CLI not on PATH. Install: clone https://github.com/garrytan/gbrain, then: bun install && bun link, then: gbrain init';
      }
      resolveP(out);
    });
  });
}

async function gbrainSearch(query) {
  requireAllow('gbrain');
  if (!query) throw new Error('query required');
  const out = await gbrainCli(`gbrain search ${shellQuote(query)}`);
  return { ok: out.exitCode === 0, data: out };
}

async function gbrainQuery(question) {
  requireAllow('gbrain');
  if (!question) throw new Error('question required');
  const out = await gbrainCli(`gbrain query ${shellQuote(question)}`, { timeout: 120_000 });
  return { ok: out.exitCode === 0, data: out };
}

async function gbrainGet(slug) {
  requireAllow('gbrain');
  if (!slug) throw new Error('slug required');
  const out = await gbrainCli(`gbrain get ${shellQuote(slug)}`);
  return { ok: out.exitCode === 0, data: out };
}

async function gbrainList({ type, tag } = {}) {
  requireAllow('gbrain');
  let cmd = 'gbrain list';
  if (type) cmd += ` --type ${shellQuote(type)}`;
  if (tag)  cmd += ` --tag ${shellQuote(tag)}`;
  const out = await gbrainCli(cmd);
  return { ok: out.exitCode === 0, data: out };
}

async function gbrainPut(slug, content) {
  requireAllow('gbrain');
  if (!slug || typeof content !== 'string') throw new Error('slug and content required');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`content > ${MAX_FILE_BYTES} bytes`);
  const ok = await confirmAction('gbrain', 'gbrain put (write page)', {
    slug, bytes: Buffer.byteLength(content, 'utf8'), preview: content.slice(0, 200),
  });
  if (!ok) return { ok: false, error: 'denied by user' };
  const tmp = join(tmpdir(), `gbrain-${randomBytes(4).toString('hex')}.md`);
  writeFileSync(tmp, content, 'utf8');
  try {
    const out = await gbrainCli(`Get-Content ${shellQuote(tmp)} -Raw | gbrain put ${shellQuote(slug)}`);
    return { ok: out.exitCode === 0, data: out };
  } finally {
    try { unlinkSync(tmp); } catch { /* noop */ }
  }
}

async function gbrainDelete(slug) {
  requireAllow('gbrain');
  if (!slug) throw new Error('slug required');
  const ok = await confirmAction('gbrain', 'gbrain DELETE page', { slug });
  if (!ok) return { ok: false, error: 'denied by user' };
  const out = await gbrainCli(`gbrain delete ${shellQuote(slug)}`);
  return { ok: out.exitCode === 0, data: out };
}

async function gbrainBacklinks(slug) {
  requireAllow('gbrain');
  if (!slug) throw new Error('slug required');
  const out = await gbrainCli(`gbrain backlinks ${shellQuote(slug)}`);
  return { ok: out.exitCode === 0, data: out };
}

async function gbrainGraphQuery(slug, { depth, direction, type } = {}) {
  requireAllow('gbrain');
  if (!slug) throw new Error('slug required');
  let cmd = `gbrain graph-query ${shellQuote(slug)}`;
  if (depth)     cmd += ` --depth ${Number(depth) | 0}`;
  if (direction) cmd += ` --direction ${shellQuote(direction)}`;
  if (type)      cmd += ` --type ${shellQuote(type)}`;
  const out = await gbrainCli(cmd);
  return { ok: out.exitCode === 0, data: out };
}

async function gbrainStats() {
  requireAllow('gbrain');
  const out = await gbrainCli('gbrain stats');
  return { ok: out.exitCode === 0, data: out };
}

async function gbrainDoctor() {
  requireAllow('gbrain');
  const out = await gbrainCli('gbrain doctor --json --fast');
  return { ok: out.exitCode === 0, data: out };
}

/* ----------------------- services -------------------------------- */

async function serviceList(filter = '') {
  requireAllow('services');
  const f = filter ? `'*${String(filter).replace(/'/g, "''")}*'` : `'*'`;
  const out = await runPowerShell(`Get-Service -Name ${f} | Select-Object Name,Status,DisplayName | ConvertTo-Json -Compress`);
  let parsed;
  try { parsed = JSON.parse(out); } catch { parsed = out; }
  if (!Array.isArray(parsed) && parsed) parsed = [parsed];
  return { ok: true, data: parsed };
}

async function serviceStatus(name) {
  requireAllow('services');
  if (typeof name !== 'string' || !name) throw new Error('service name required');
  const out = await runPowerShell(`Get-Service -Name '${name.replace(/'/g, "''")}' | Select-Object Name,Status,DisplayName,StartType | ConvertTo-Json -Compress`);
  let parsed; try { parsed = JSON.parse(out); } catch { parsed = out; }
  return { ok: true, data: parsed };
}

async function serviceControl(action, name) {
  requireAllow('services');
  if (typeof name !== 'string' || !name) throw new Error('service name required');
  const verb = { start: 'Start', stop: 'Stop', restart: 'Restart' }[action];
  if (!verb) throw new Error('action must be start|stop|restart');
  const ok = await confirmAction('services', `SERVICE ${verb.toUpperCase()}`, { name });
  if (!ok) return { ok: false, error: 'denied by user' };
  await runPowerShell(`${verb}-Service -Name '${name.replace(/'/g, "''")}' -Force`);
  return { ok: true };
}

/* ----------------------- command dispatcher ----------------------- */

async function executeCommand(msg) {
  const { action, params = {} } = msg;
  try {
    switch (action) {
      // mouse / keyboard / screen — always available
      case 'screen_size':        return { ok: true, data: await screenSize() };
      case 'mouse_move':         return { ...(await mouseMove(params.x, params.y)) };
      case 'mouse_click':        return { ...(await mouseClick(params.x, params.y, params.button)) };
      case 'mouse_double_click': return { ...(await mouseDoubleClick(params.x, params.y)) };
      case 'key_type':           return { ...(await keyType(params.text)) };
      case 'key_combo':          return { ...(await keyCombo(params.combo)) };
      case 'screenshot':         return await screenshot();
      case 'open_app':           return { ...(await openApp(params.name)) };

      // shell — needs --allow=shell
      case 'shell':              return await shellExec(params.command, { cwd: params.cwd, timeout: params.timeout });

      // filesystem — needs --allow=fs
      case 'read_file':          return await readFile(params.path);
      case 'write_file':         return await writeFile(params.path, params.content, !!params.append);
      case 'delete_file':        return await deleteFile(params.path);
      case 'list_dir':           return await listDir(params.path);

      // registry — needs --allow=registry
      case 'registry_read':      return await registryRead(params.path, params.name);
      case 'registry_write':     return await registryWrite(params.path, params.name, params.value, params.type);

      // services — needs --allow=services
      case 'service_list':       return await serviceList(params.filter);
      case 'service_status':     return await serviceStatus(params.name);
      case 'service_start':      return await serviceControl('start', params.name);
      case 'service_stop':       return await serviceControl('stop', params.name);
      case 'service_restart':    return await serviceControl('restart', params.name);

      // gbrain — needs --allow=gbrain
      case 'gbrain_search':      return await gbrainSearch(params.query);
      case 'gbrain_query':       return await gbrainQuery(params.question || params.q);
      case 'gbrain_get':         return await gbrainGet(params.slug);
      case 'gbrain_list':        return await gbrainList(params);
      case 'gbrain_put':         return await gbrainPut(params.slug, params.content);
      case 'gbrain_delete':      return await gbrainDelete(params.slug);
      case 'gbrain_backlinks':   return await gbrainBacklinks(params.slug);
      case 'gbrain_graph_query': return await gbrainGraphQuery(params.slug, params);
      case 'gbrain_stats':       return await gbrainStats();
      case 'gbrain_doctor':      return await gbrainDoctor();

      // playwright — needs --allow=playwright
      case 'playwright_navigate':      requireAllow('playwright'); return { ok: true, data: await pw.pwNavigate(params) };
      case 'playwright_click':         requireAllow('playwright'); return { ok: true, data: await pw.pwClick(params) };
      case 'playwright_fill':          requireAllow('playwright'); return { ok: true, data: await pw.pwFill(params) };
      case 'playwright_press':         requireAllow('playwright'); return { ok: true, data: await pw.pwPress(params) };
      case 'playwright_get_text':      requireAllow('playwright'); return { ok: true, data: await pw.pwGetText(params) };
      case 'playwright_get_attribute': requireAllow('playwright'); return { ok: true, data: await pw.pwGetAttribute(params) };
      case 'playwright_wait_for':      requireAllow('playwright'); return { ok: true, data: await pw.pwWaitFor(params) };
      case 'playwright_screenshot':    requireAllow('playwright'); return { ok: true, data: await pw.pwScreenshot(params) };
      case 'playwright_list_pages':    requireAllow('playwright'); return { ok: true, data: await pw.pwListPages() };
      case 'playwright_close_page':    requireAllow('playwright'); return { ok: true, data: await pw.pwClosePage(params) };
      case 'playwright_eval': {
        requireAllow('playwright');
        const ok = await confirmAction('playwright', 'playwright_eval (arbitrary JS in page)', { code: params.code });
        if (!ok) return { ok: false, error: 'denied by user' };
        return { ok: true, data: await pw.pwEval(params) };
      }

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
    if (msg.type === 'control' && msg.action === 'set_auto_approve') {
      setAutoApprove(msg.values);
      return;
    }
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

process.on('SIGINT', async () => {
  console.log('\nshutting down.');
  try { socket?.close(); } catch { /* noop */ }
  try { await pw.pwShutdown(); } catch { /* noop */ }
  rl.close();
  process.exit(0);
});
