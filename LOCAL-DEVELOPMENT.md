# vaft playback improvements and setup

This branch targets Firefox with full uBlock Origin. It keeps a working backup
player type for an ad break, waits for two advancing clean playlists before
returning, and resumes the replacement Twitch player after a reload instead of
calling `play()` on the instance being removed. Recovery retries once if playback
does not advance, and stops on navigation or an explicit pause through the player
controls. It verifies playback progress, not the actual audio/video offset.

Other changes bound backup requests and back off failed searches, propagate playlist-processing errors,
ignore outdated responses, tolerate missing server-time/codec metadata, and keep
ad stripping active when rendition metadata is missing. The existing ad-stripping
mechanism and Twitch access-token strategy are retained. No new proxy is used.

## Hosted setup for Firefox

GitHub serves the script directly from this fork. You do not need a local server,
autostart task, GitHub Pages site, or separate hosting account.

In uBlock Origin, enable **Settings → I am an advanced user**, open the settings
cog, and replace the existing pixeltris vaft resource URL with:

```text
userResourcesLocation https://raw.githubusercontent.com/antidrew/TwitchAdSolutions/vaft-playback-recovery/vaft/vaft-ublock-origin.js
```

Preserve any unrelated resource URLs already on that line. In **My filters**, use:

```text
twitch.tv##+js(twitch-videoad)
```

Apply changes, refresh the cached **uBlock filters** resource in **Filter lists**,
disable/re-enable uBlock Origin if needed, and reload Twitch. The resource is cached,
so editing the file alone does not immediately change the injected script.

The branch URL follows published updates when uBlock refreshes its cached resource.
To freeze a tested version, replace `vaft-playback-recovery` in the URL with that
commit's full SHA. An unpublished local edit has no effect on the hosted script.

Use one Twitch-specific blocking script at a time. Check the Firefox web console
for `hookWorkerFetch (vaft)` and `[vaft]` recovery messages. A small **Resync** button
appears on live streams; it recreates the player without refreshing chat. Set
`ShowResyncButton` to `false` to hide it.

If the audio still falls out of sync, collect the diagnostic history with:

```js
vaftDiagnostics()
```

The history contains the last 100 recovery/fallback events, without token URLs or
authorization headers. `reloadTwitchPlayer()` also requests a manual resync.

The updated code has automated regression coverage. A real Firefox ad-break test
is still required to establish its effect on lip-sync and current Twitch behavior.
Test entry/exit of midroll ads, muted streams, quality changes, raids/channel
navigation, and paused playback. Compare whether a pause/play or player reload
actually fixes a remaining desync. No seamless stream is possible when every
available fallback contains ads; that case continues to strip ad segments.

## Development and checks

Edit `vaft/vaft.user.js` as the source, then regenerate the uBlock resource:

```powershell
node scripts/sync-vaft.mjs
node scripts/sync-vaft.mjs --check
node --check vaft/vaft.user.js
node --test tests/vaft.test.mjs
```

The userscript update/download URLs point to this fork's `vaft-playback-recovery`
branch, rather than pixeltris's archived copy.

## Optional local development server

To test unpublished local edits, run:

```powershell
node scripts/serve-vaft.mjs
```

The server binds to `127.0.0.1` and serves only the two vaft script files. While it
is running, use `http://127.0.0.1:8765/vaft/vaft-ublock-origin.js` as the resource
URL and refresh uBlock's cache. `VAFT_PORT` can override port 8765. Return to the
hosted URL when finished.

To roll back in uBlock Origin, restore the previous resource URL, refresh its cache,
and reload Twitch. An optional local server can be stopped with Ctrl+C.
