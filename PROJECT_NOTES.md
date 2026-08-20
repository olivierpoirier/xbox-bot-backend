# Project Notes

Last updated: 2026-08-20

## Local Audio Setup

- MPV is installed via Scoop.
- MPV executable path: `C:\Users\poiri\scoop\apps\mpv\current\mpv.exe`
- `backend/.env` has been updated with:
  - `MPV_BIN=C:\Users\poiri\scoop\apps\mpv\current\mpv.exe`
- VoiceMeeter exists at the default backend path:
  - `C:\Program Files (x86)\VB\Voicemeeter\voicemeeterpro.exe`
- VoiceMeeter routing test passed:
  - virtual sink: `VoiceMeeter`
  - virtual monitor/source: `B2`
  - MPV audio device: `wasapi/{422c5f03-d063-4b65-b529-c54272b9bac9}`
- A short generated WAV playback test through backend MPV + VoiceMeeter passed in about 10 seconds.

## Backend Decisions

- Do not require a password/token for guests. The app is intended to be shared with a trusted group through Cloudflare Tunnel.
- Keep invisible safety protections:
  - Socket.IO payload size limit
  - light per-socket rate limit
  - payload validation
  - optional CORS allowlist through `BACKEND_ALLOWED_ORIGINS`
- YouTube should prioritize audio-only streams for Discord/audio use.
- MP4/HLS YouTube formats should remain as fallback only, because they can be more robust when audio-only URLs fail in MPV.
- Spotify links should not require guests to log in.
- Spotify flow should remain:
  - Spotify metadata from server credentials
  - search a playable source from metadata
  - play through MPV + VoiceMeeter
- SoundCloud metadata should use oEmbed first to avoid long yt-dlp waits.
- SoundCloud direct playback should fail quickly, then fallback toward YouTube search when possible.
- Repeated provider matches should be cached in memory:
  - Spotify query/duration -> YouTube result
  - repeated YouTube searches -> cached result
  - SoundCloud URL -> learned YouTube fallback after direct SoundCloud fails

## Measured Backend Timings

- VoiceMeeter readiness: about 14.9 s
- Backend idle memory during local server test:
  - RSS: about 86 MB
  - heap used: about 15 MB
- Spotify track metadata: about 0.2-0.4 s
- Spotify link to YouTube search to playable audio URL: about 5.0-5.3 s
- Web UI Spotify submit test:
  - Spotify URL accepted from the UI once `Operator ID` is filled
  - queue UI update: about 0.9 s
  - playback UI update after queue entry: about 0.6 s
  - final playable match for `Never Gonna Give You Up`: `https://www.youtube.com/watch?v=dQw4w9WgXcQ`
- YouTube playable audio extraction: about 3.9-5.8 s
- SoundCloud metadata through oEmbed: about 0.3-0.5 s
- SoundCloud direct stream timeout after optimization: about 5.1 s
- SoundCloud with fallback toward YouTube: about 9.1 s
- YouTube search cache test:
  - first `Rick Astley - Never Gonna Give You Up official audio` lookup used `play-dl`
  - second identical lookup returned from cache
- SoundCloud fallback query cleanup test:
  - `Stream My Track by My Artist | Listen online for free on SoundCloud`
  - becomes `My Artist - My Track`

## Current Verification Status

- Backend TypeScript type-check: OK
- Backend production audit: 0 vulnerabilities
- Backend build: OK when run outside the sandbox, because `backend/dist` denies writes inside the sandbox.
- Web UI Spotify playback path: OK in local browser test.
- Backend provider/search cache targeted runtime test: OK.
- Frontend TypeScript/build/lint: OK.
- Frontend browser UI test: OK for source input, optional operator input, paste buttons, submit, section collapse/open, queue controls, player controls, seek slider, theme header controls, and desktop theme dock.
- Frontend CSS build warning about `align-items: end` was fixed by using `flex-end`.

## Frontend Notes

- `Operator ID` is optional; empty names submit as `anon`.
- Source input now shows detected source state for Spotify, YouTube, SoundCloud, generic links, and text search.
- Submit button now explains the disabled state with `Signal requis`.
- Player icon controls have accessible labels so browser tests can target them reliably.
- Supported links help text encoding was corrected.

## Remaining Work

- Test Discord capture quality while in a real Discord voice channel.
- Confirm Discord input is listening to the intended VoiceMeeter virtual output/source.
- Consider a faster official SoundCloud streaming path if an API token/client setup becomes available; otherwise keep the current fast metadata plus cached YouTube fallback behavior.
- Consider persistent cache if Spotify/SoundCloud matches should survive backend restarts.
