# TNT-CLI

HBO Max UK / **TNT Sports** CLI — browse, playback (MPD + Widevine keys), and **N_m3u8DL-RE** downloads.

**Author:** Kh4N_PCT

## Quick start

1. Copy `.env.example` → `.env` and set `TNT_PROXY`, `TNT_EMAIL`, `TNT_PASSWORD`.
2. `npm run setup`
3. `node tnt_cmd.js` or `tnt.cmd`

Full setup, login, and troubleshooting: **[SETUP.md](SETUP.md)**.

## Requirements

- Node.js 18+
- UK proxy (see `.env.example`)
- [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE) on PATH or `TNT_NM3U8DL`

Do **not** commit `.env`, `tnt-token.json`, or `Discovery+ Keys.txt`.
