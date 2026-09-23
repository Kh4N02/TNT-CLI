# TNT / HBO Max CLI — setup

CLI for **TNT Sports on HBO Max UK** (`https://play.hbomax.com`).

Downloads use **N_m3u8DL-RE** only — no Python, no `cmds/` device files, no CDN bridge.

## First run on a new PC

```powershell
Remove-Item -Recurse -Force .tnt-browser-profile -ErrorAction SilentlyContinue
Remove-Item -Force tnt-token.json -ErrorAction SilentlyContinue
```

## Prerequisites

| Tool | Notes |
|------|--------|
| **Node.js 20+** | |
| **Google Chrome** | Playwright — HBO Max login |
| **UK proxy** | `TNT_PROXY` in `.env` (Webshare GB) |
| **Clash / tunnel** | `TNT_PROXY_TUNNEL=127.0.0.1:7897` for browser + N_m3u8DL-RE |
| **N_m3u8DL-RE** | On PATH or `TNT_NM3U8DL` in `.env` |

## Install

```powershell
cd TNT-CLI
copy .env.example .env
npm install
npx playwright install chrome
```

Or double-click **`tnt.cmd`**.

## `.env` example

```env
TNT_PROXY=37.44.218.117:5800:udiwafqs:yourpass
TNT_PROXY_TUNNEL=127.0.0.1:7897
TNT_EMAIL=you@example.com
TNT_PASSWORD=...
```

## Run

```powershell
node tnt_cmd.js
```

After you pick an event, the CLI resolves the MPD, gets **KID:KEY** pairs (remote CDM over HTTPS — not Python), builds an **N_m3u8DL-RE** command with your Bearer token + `st` cookie + UK proxy, and opens a download window.

HBO Max may show a **bot puzzle**. Chrome stays open up to **15 minutes** while you solve it (do not use `TNT_BROWSER_HEADLESS=1` for login).

Manual login (you type everything + puzzle):

```powershell
$env:TNT_MANUAL_LOGIN="1"
node tnt_cmd.js
```

Headless (not recommended for first login):

```powershell
$env:TNT_BROWSER_HEADLESS="1"
node tnt_cmd.js
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Proxy / region | UK exit on Clash matching `TNT_PROXY` |
| N_m3u8DL not found | Set `TNT_NM3U8DL` to full path |
| 403 on segments | Keep tunnel on; same proxy as login |
| Key step fails | VPN up, re-login (delete `tnt-token.json`) |
| `Mux failed` after download | CLI defaults to Shaka + MP4 + AAC (`codecs=mp4a`). For 5.1 EAC3 in MKV use `TNT_MUX_AFTER_DONE=format=mkv:muxer=ffmpeg` and `TNT_AUDIO_SELECT=best:for=best` |

**Do not commit `.env`.**

Password contains `#`? Use quotes: `TNT_PASSWORD="Trumpet12#"`.

Browser login uses **TNT_PROXY** (UK Webshare) directly. To route browser through Clash instead, set `TNT_BROWSER_VIA_TUNNEL=1`.
