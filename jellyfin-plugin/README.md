# Cinephage Jellyfin plugin

Jellyfin plays media; Cinephage files it. Jellyfin has no shortcut handling for
**audio** `.strm` files, so an audio shortcut resolves to its URL as text instead
of a stream. This plugin adds that missing piece and is the place future
Cinephage↔Jellyfin integration belongs.

It does one thing today: when a music item's file is a `.strm`, it reads the URL
and serves the stream through Jellyfin (`IsRemote = false`), so the stream URL —
including Cinephage's API key — never reaches the client. Local paths inside a
`.strm` are refused, matching Jellyfin's own rule for video shortcuts.

## Build

The .NET SDK runs in a container; the dev box needs only Docker and Python 3.

```sh
cd jellyfin-plugin
./build.sh
```

Output lands in `dist/<targetAbi>/`: the plugin zip and the repository manifest
the app serves at `/api/jellyfin-plugin/manifest.json`. The app reads that
directory at runtime; `dist/` is not committed.

`TARGET_ABI` (default `12.4.0.0`) selects the Jellyfin ABI to build against.
The Docker image builds the same package in its `jellyfin-plugin` stage.

## How it reaches a Jellyfin server

Cinephage registers itself as a plugin repository on the configured Jellyfin
server and asks Jellyfin to install the package — the same flow as Jellyfin's
own plugin catalogue. The user clicks **Install Cinephage plugin** on
Settings → Integrations → Media Servers; see
`src/lib/server/notifications/mediabrowser/cinephagePlugin.ts`.
