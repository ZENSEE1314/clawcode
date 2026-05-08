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

## What it deliberately can't do (yet)

- ❌ Shell command execution
- ❌ File read / file write
- ❌ Registry, services, or any system administration
- ❌ Anything outside the calls above

If you want shell access later, ping me and I'll add it with a per-command
confirmation prompt.

## Why this design

The Chrome extension can only see and control browser tabs. To click a button
in Notepad or move your real cursor, the request has to be executed by a
program that runs natively on Windows. This is that program. It pairs to the
same Railway WebSocket relay using the same token as the extension.

## Install

```powershell
cd C:\Users\<you>\claw-code\desktop-helper
npm install
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
- If you ever lose the token, delete `~/.claw-desktop-helper.json` AND
  generate a new one in the web app (Browser tab → just clear localStorage
  and reload to regenerate, or rotate manually).
- The chat model (gpt-oss:120b-cloud) is good but not perfect. It WILL
  occasionally do the wrong thing. Watch what it does, especially early.
- Hit Ctrl+C in the helper window to kill control immediately.

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
