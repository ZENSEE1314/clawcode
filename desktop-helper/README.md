# claw desktop helper

A small Node script that runs on **your Windows PC** and lets the claw-code
chat at https://clawcode-production.up.railway.app drive your **mouse,
keyboard, and screen** — not just the browser tab.

## What it can do (v1, deliberately small)

- `screenshot` — capture the whole virtual desktop, send back as PNG
- `screen_size` — return primary screen dimensions
- `mouse_move(x, y)` — move the cursor
- `mouse_click(x, y, button?)` — left/right/middle click at a point
- `mouse_double_click(x, y)`
- `key_type(text)` — type a string into whatever is focused
- `key_combo("ctrl+c")` — keyboard shortcut
- `open_app("notepad")` — launch an application by name

## What it can do (opt-in, with confirmation)

These categories are **off by default** — pass `--allow=<category>` flags
when you start the helper to enable them. With confirmation on (the
default), every WRITE/DESTRUCTIVE call pops a `y/N` prompt in the helper's
PowerShell window. You see exactly what the model wants to do.

| Category | Flag | Read-only commands (no prompt) | Mutating commands (prompt unless `--yolo`) |
|---|---|---|---|
| Shell | `--allow=shell` | — | `shell {command}` (runs PowerShell, returns stdout/stderr) |
| Filesystem | `--allow=fs` | `read_file`, `list_dir` | `write_file`, `delete_file` |
| Registry | `--allow=registry` | `registry_read` | `registry_write` |
| Services | `--allow=services` | `service_list`, `service_status` | `service_start`, `service_stop`, `service_restart` |
| Playwright | `--allow=playwright` | `playwright_navigate/click/fill/press/get_text/get_attribute/wait_for/screenshot/list_pages/close_page` | `playwright_eval` (arbitrary JS in page) |
| gbrain | `--allow=gbrain` | `gbrain_search/query/get/list/backlinks/graph_query/stats/doctor` | `gbrain_put`, `gbrain_delete` |

### gbrain (the AI's persistent semantic memory)

[gbrain](https://github.com/garrytan/gbrain) gives the AI a real local memory:
hybrid vector + keyword + graph search over markdown pages. Much better than
the in-app Memory tab for anything you want to recall over weeks/months.

**One-time install (Windows, PowerShell):**

```powershell
# 1. Install Bun if you don't have it
irm bun.sh/install.ps1 | iex

# 2. Clone gbrain and link the CLI
git clone https://github.com/garrytan/gbrain.git
cd gbrain
bun install
bun link

# 3. Initialize the local DB (PGLite, embedded — no Postgres install needed)
gbrain init

# 4. (Optional) ingest a folder of notes to seed it
gbrain import C:\Users\<you>\notes
```

After install, restart the helper with `--allow=gbrain` and the AI can
query/save pages. The chat's system prompt automatically teaches the model
the toolset when this category is enabled.

### Playwright (the AI's own browser)

Separate Chromium instance launched inside the helper process — does NOT
share cookies, sessions, or auth with your real Chrome. Useful for scraping,
form-filling, and automation tasks where you don't want the AI taking over
your main browser.

After `npm install`, run **once**:

```powershell
npx playwright install chromium
```

This downloads the Chromium binary (~300 MB). Pass `--playwright-headless`
when starting the helper if you don't want the browser window to pop up.

Examples:

```powershell
# Mouse + keyboard + screenshot only (default — safest)
node helper.js --token=tok_xxx

# Plus shell — every shell command will prompt y/N
node helper.js --token=tok_xxx --allow=shell

# Everything — but still prompts for any destructive action
node helper.js --token=tok_xxx --allow=shell,fs,registry,services

# YOLO MODE — destructive actions run without prompting. Use sparingly.
node helper.js --token=tok_xxx --allow=shell,fs --yolo
```

## Hard limits

- Files: 5 MB cap on read AND write.
- Shell: 5-minute max timeout per command.
- Registry: only the standard hives (HKCU, HKLM, HKCR, HKU, HKCC).
- All destructive ops require an interactive `y/N` (unless `--yolo`).
- The helper does not run with elevated privileges unless you launch it from
  an admin PowerShell. To install services or write to HKLM, run as admin.

## Why this design

The Chrome extension can only see and control browser tabs. To click a button
in Notepad or move your real cursor, the request has to be executed by a
program that runs natively on Windows. This is that program. It pairs to the
same Railway WebSocket relay using the same token as the extension.

## Install

```powershell
cd C:\Users\<you>\claw-code\desktop-helper
npm install

# Only if you want Playwright (the AI's own browser):
npx playwright install chromium
```

## Run

Get your **pairing token** from the web app: open https://clawcode-production.up.railway.app,
right panel → **Browser** tab → copy the token (e.g. `tok_abc123…`).

Then in PowerShell:

```powershell
node helper.js --token=tok_abc123XXXX
```

You should see:

```
┌─────────────────────────────────────────
│ claw desktop helper
│ relay: wss://clawcode-production.up.railway.app/ws
│ token: tok_abc1…XXXX
└─────────────────────────────────────────

connecting…
✓ connected
```

The token is saved to `~/.claw-desktop-helper.json` so subsequent runs
work with just `node helper.js`.

Leave this PowerShell window open while you want the chat to be able to
control your PC. Close it (Ctrl+C) to revoke control instantly.

## Use

In the web app chat, with the Brain agent active and the desktop helper
running, try:

```
take a screenshot of my desktop and tell me what's open
```

```
open notepad and type "hello world"
```

```
move my mouse to 800, 400
```

The chat will emit `<action>{...}</action>` blocks targeting `desktop`,
the helper executes them, and results stream back.

## Auto-start (optional)

To launch on Windows login, create a shortcut to:

```
powershell.exe -WindowStyle Hidden -Command "cd C:\Users\<you>\claw-code\desktop-helper; node helper.js"
```

…and drop it in `shell:startup` (Win+R → type `shell:startup` → Enter).

## Safety notes

- The helper trusts whoever has your pairing token. Don't share it.
- The chat model (gpt-oss:120b-cloud) is good but not perfect. It WILL
  occasionally do the wrong thing.
- **Per-command confirmation is your seat belt.** Read the prompt before
  typing `y`. The format is:
  ```
  ──────── confirm ────────
    shell command
    command : git status
    cwd     : C:\Users\Zen See\projects
  allow? [y/N]:
  ```
  Default to `N` if anything looks wrong.
- `--yolo` removes that seat belt. The helper prints a giant warning if
  you use it. Don't combine `--yolo` with `--allow=shell` casually.
- Hit `Ctrl+C` in the helper window to kill control instantly.
- To rotate the pairing token: clear localStorage in the web app (DevTools
  → Application → Local Storage → clear `clawcode-production.up.railway.app`),
  reload, copy the new token, restart the helper with the new `--token=…`.

## Troubleshooting

- **"connecting…" forever** → Token wrong, or relay URL blocked. Verify
  the token matches what the web app shows under "Pairing token".
- **PowerShell errors about ExecutionPolicy** → The helper passes
  `-ExecutionPolicy Bypass` per-call, but if your domain locks this down,
  ask your admin or set `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- **SendKeys can't type some characters** → The helper escapes the
  reserved set (`+ ^ % ~ ( ) { } [ ]`) but if you find a character that
  breaks it, file an issue.
- **Windows-key shortcuts (`win+l` etc.)** → Not supported by SendKeys.
  Use a different combo or specify what you want and I'll add user32
  P/Invoke for those.
