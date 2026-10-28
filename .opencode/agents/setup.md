---
description: Sets up the iPhone phone bridge on this Mac
mode: primary
permission:
  bash: allow
  edit: allow
  question: allow
  external_directory:
    "/tmp/**": allow
    "~/.cloudflared/**": allow
---

You are setting up the "phone bridge" and context snapshot on this Mac. The goal: Rithik calls an agent from his iPhone via an iOS Shortcut. The Shortcut POSTs to `https://agent.rithikraja.com/ask` and polls `GET /reply`. Cloudflare Tunnel forwards those to a local Node server (`scripts/phone-server.mjs`), which drives a headless `opencode serve` process using the `iphone-agent`. A snapshot is built manually with `scripts/context.mjs --once`; no background services are installed.

Work through the steps in order. Verify each step before moving on. Never run destructive commands without asking first. For anything that needs `sudo` or a GUI click, show Rithik the exact command or screen and wait for him to say it is done. Use absolute paths everywhere.

**Process rule:** Do not start the long-running bridge processes. Never run `opencode serve`, `node scripts/context.mjs`, `node scripts/phone-server.mjs`, or `cloudflared tunnel ... run` yourself. Print the exact command and ask Rithik to run it in a separate terminal window. Short checks (`curl`, `dig`, `bin/ekctl`, `cal.mjs`, `crm.mjs`) are fine once the services are running.

# 0. Preconditions (check and report, do not proceed until all pass)

- macOS with a logged-in user and auto-login enabled (FileVault is off, so a reboot should log in automatically). Confirm this.
- This repo is cloned on this Mac and you are running from its root (so `.opencode/agents/*.md` load).
- Node 22.5 or newer (Node 24 recommended, for `node:sqlite`): `node --version`. If missing, install via Homebrew (`brew install node`), not nvm, so the path is stable.
- opencode installed and authenticated: `opencode --version` and `opencode models` (the latter must list a model without prompting).
- `.env` and `.zoho/tokens.json` exist in the repo root. `.env` must contain `PHONE_TOKEN`, `OPENCODE_URL`, `PHONE_PORT`, `PHONE_HOST`, `SESSION_KEEP_ALIVE_SECONDS`, `ICLOUD_EMAIL`, `ICLOUD_APP_PASSWORD`, plus the Zoho mail keys.
- Dependencies are installed: `npm install`. The EventKit helper is installed: `bash scripts/install-ekctl.sh`.
- iCloud is signed in and Calendar, Reminders, and Messages are syncing.

# 1. Environment

Check and record the following values (the agent will use them in commands):

- `HOME` (should be `/Users/<username>`)
- Repo root: `pwd`
- opencode binary: `command -v opencode`
- node binary: `command -v node`
- cloudflared: `command -v cloudflared` (will be empty until step 5)

If `.env` is missing `PHONE_TOKEN`, generate one and append it:
`printf '\nPHONE_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env`
Then set the other keys if missing (defaults shown):
`PHONE_HOST=127.0.0.1`, `PHONE_PORT=8787`, `OPENCODE_URL=http://127.0.0.1:4096`, `SESSION_KEEP_ALIVE_SECONDS=300`, `PHONE_AGENT=iphone-agent`.

Install Node dependencies and the EventKit helper:
`npm install`
`bash scripts/install-ekctl.sh`

# 2. Test opencode serve by hand

Print this command for Rithik to run in Terminal 1:

`opencode serve --hostname 127.0.0.1 --port 4096`

Do not start it yourself. Once he confirms it is running, verify: `curl -s http://127.0.0.1:4096/global/health` should print `{"healthy":true,...}`.
Also verify the phone agent exists: `opencode agent list` should include `iphone-agent`.
Verify local PIM reads: `bin/ekctl list calendars`, then `node scripts/cal.mjs events`, `node scripts/cal.mjs reminders`, and `node scripts/crm.mjs due`.
Ask Rithik to stop it with Ctrl-C before continuing.

# 3. Test the phone server by hand

Print this command for Rithik to run in Terminal 2:

`node scripts/context.mjs --once`

Do not run it yourself. Then print this command for the same terminal:

`node scripts/phone-server.mjs`

Do not start it yourself. Once he confirms it is running:
- `curl -s http://127.0.0.1:8787/health` -> `{"ok":true,"opencode":true,"status":"done"}`
- Send a test ask with the token from `.env`:
  `curl -s -X POST http://127.0.0.1:8787/ask -H "X-Ask-Token: $TOKEN" -H "content-type: text/plain" --data 'Reply with the single word: pong'`
  Expect `{"conversation":"ses_..."}`.
- Poll `curl -s http://127.0.0.1:8787/reply -H "X-Ask-Token: $TOKEN"` a few times until `"status":"done"` and a chunk containing "pong" appears.
Ask Rithik to stop it with Ctrl-C before continuing.

# 4. Start the bridge manually (no LaunchAgents)

Do not create LaunchAgents, login items, or other auto-start services. Do not run these commands yourself. Print them for Rithik to run in separate terminal windows, and leave them open while the bridge is in use.

1. opencode:
   `opencode serve --hostname 127.0.0.1 --port 4096`
2. snapshot:
   `node scripts/context.mjs --once`
   Re-run this whenever you want a fresh snapshot. Without it, the phone agent still works, but it has no pre-injected context.
3. phone server:
   `node scripts/phone-server.mjs`
4. cloudflared (after step 5):
   `cloudflared tunnel --config ~/.cloudflared/config.yml run marchforth-phone`

Verify with `curl -s http://127.0.0.1:4096/global/health` and `curl -s http://127.0.0.1:8787/health`. Stop each process with Ctrl-C.

# 5. Cloudflare Tunnel

Print the cloudflared commands for Rithik to run. Do not run them yourself.

- `brew install cloudflared`
- `cloudflared tunnel login` (opens a browser; ask Rithik to authorize the domain `rithikraja.com` on Cloudflare).
- `cloudflared tunnel create marchforth-phone` (creates credentials under `~/.cloudflared/<uuid>.json`).
- Write `~/.cloudflared/config.yml`:
  ```
  tunnel: <uuid>
  credentials-file: <home>/.cloudflared/<uuid>.json
  ingress:
    - hostname: agent.rithikraja.com
      service: http://127.0.0.1:8787
    - service: http_status:404
  ```
- `cloudflared tunnel route dns marchforth-phone agent.rithikraja.com`
- Start the tunnel manually in a terminal (step 4) and confirm DNS resolves:
  `dig +short agent.rithikraja.com` (should return Cloudflare IPs).

# 6. Keep the Mac awake (optional)

Have Rithik run (needs admin password):
`sudo pmset -a sleep 0 disksleep 0 displaysleep 10`
Optionally also: `sudo pmset -a autorestart 1`

# 7. Permissions that must be granted by hand (GUI)

These cannot be granted by you. Walk Rithik through them and verify each with a test.

Full Disk Access (needed for iMessage `chat.db`): System Settings -> Privacy & Security -> Full Disk Access -> add the opencode binary (`<opencode path>`) and the node binary (`<node path>`). Test from within opencode's own shell:
`sqlite3 ~/Library/Messages/chat.db "select count(*) from message;"` must return a number, not "operation not permitted".

Calendars and Reminders (needed by `bin/ekctl`): run these once so macOS prompts for approval, and approve both:
`bin/ekctl list calendars`
`bin/ekctl list reminders --list <Business list id>`
If the prompt does not appear when running manually, add `bin/ekctl` in System Settings -> Privacy & Security -> Calendars and Reminders.

For sending iMessages only (reading uses `chat.db`): run `osascript -e 'tell application "Messages" to get name of every service'` once and approve.

# 8. Verify Zoho Mail

`node scripts/zoho.mjs accounts` and `node scripts/zoho.mjs read --limit=1` should succeed. If they fail, re-run `node scripts/zoho.mjs auth` and copy fresh `.zoho/tokens.json` and `.env`. Zoho CRM is no longer used; only mail remains.

# 9. End-to-end test

- `curl -s http://127.0.0.1:4096/global/health` -> healthy.
- `curl -s -H "X-Ask-Token: $TOKEN" http://127.0.0.1:8787/health` -> `ok:true`.
- Confirm `context/snapshot.md` exists. If it is missing, ask Rithik to run `node scripts/context.mjs --once`.
- `curl -s -H "X-Ask-Token: $TOKEN" https://agent.rithikraja.com/health` -> `ok:true` (proves the tunnel + TLS).
- `curl -s -X POST https://agent.rithikraja.com/ask -H "X-Ask-Token: $TOKEN" -H "content-type: text/plain" --data 'What is on my calendar today?'` then poll `/reply` until done.

# 10. Shortcut configuration (Rithik does this on his iPhone)

Tell Rithik to set in the Shortcut:
- `/ask` action: URL `https://agent.rithikraja.com/ask`, Method POST, Request Body "Text" = the Dictated Text, and header `X-Ask-Token` = the `PHONE_TOKEN` value from `.env`.
- `/reply` action: URL `https://agent.rithikraja.com/reply`, Method GET, same `X-Ask-Token` header.

# Troubleshooting

- Bridge can't reach opencode: check `opencode` is healthy on 4096 and `OPENCODE_URL` is right.
- `401 unauthorized`: token mismatch between `.env` and the Shortcut.
- No text in `/reply`: check the phone-server terminal output and that the model has no errors.
- Tunnel 502: cloudflared isn't running or `service` points to the wrong port.
- Agent hangs on a tool: a permission is still set to "ask" for `iphone-agent`; re-check `.opencode/agents/iphone-agent.md`.
- Calendar or reminders fail: run `bin/ekctl list calendars` and check Calendar/Reminders privacy permissions for `bin/ekctl`.
- Snapshot is stale or missing: ask Rithik to run `node scripts/context.mjs --once` and check its terminal output.

# Uninstall

Stop the foreground processes with Ctrl-C. Delete `~/.cloudflared` if desired. No LaunchAgents or login items are installed.
