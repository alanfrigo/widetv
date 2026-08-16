# widetv

A personal streaming server for your own video library.

Point it at a folder of series, and it becomes a widescreen catalogue: every
show gets a cover fetched automatically, a synopsis, its episode list, and the
embedded audio and subtitle tracks the files already carry. Files are served
straight from disk, never transcoded.

[Portugues](README.pt-BR.md)

## What it does

- **Catalogue.** One channel per folder, with cover art, year and synopsis.
- **Automatic covers.** Fetched once per show from TVMaze, iTunes or TMDB, then
  stored locally and served by this server. No client ever talks to a provider.
- **Audio and subtitles.** Multi-audio MKV files keep every track; embedded text
  subtitles are converted to WebVTT on demand and cached on disk.
- **Live mode.** Each series also runs as a 24-hour channel: a pure function of
  the clock decides what would be airing right now. Nothing about playback
  position is stored, so the grid survives a restart and two viewers on the same
  channel see the same frame.
- **No transcoding.** HTTP range requests over the original file. This is meant
  to run on a NAS without a GPU.

## How the schedule works

```
cycle   = sum of every episode duration
elapsed = (now - epoch) mod cycle
```

Each channel is offset by a stable hash of its slug, so the channels are not all
sitting on episode 1 at the same instant. The client fetches the current
position, measures the round trip to estimate clock skew, seeks, and then keeps
itself honest: under 300 ms of drift it does nothing, up to 2 s it nudges the
playback rate, beyond that it seeks.

## Covers and metadata

The first `GET /api/channels` after a scan kicks off a background pass that
fills in whatever is missing. The response never waits for the network — covers
show up on the next load.

Providers are tried in order, and the chain stops at the first one that returns
an image:

| Provider | Key | Notes |
| --- | --- | --- |
| TMDB | `TMDB_API_KEY` | Only when the key is set, and then it goes first: poster-sized art and a pt-BR synopsis |
| TVMaze | none | Good coverage for TV series |
| iTunes Search | none | Fallback; also covers films |

The image is downloaded once to `<DATA_DIR>/posters/<showId>.jpg` and served
from `/api/channels/:number/poster`, behind the same session guard as
everything else. A show that no provider knows is recorded as such and retried
only after seven days. A network failure records nothing at all, so it is
retried on the next pass.

## API

Every route is behind the session cookie.

| Route | Returns |
| --- | --- |
| `POST /api/auth/login` | sets the session cookie |
| `GET /api/channels` | `ChannelSummary[]` |
| `GET /api/channels/:number/now` | `NowPlaying` — what is airing right now |
| `GET /api/channels/:number/episodes` | `EpisodeRef[]` in schedule order |
| `GET /api/channels/:number/poster` | `image/jpeg`, or 404 when there is no cover |
| `GET /api/stream/:id` | the file, with range support |
| `GET /api/stream/:id/subtitle/:track` | embedded subtitle as WebVTT |

```ts
interface ChannelSummary {
  number: number;
  name: string;
  episodeCount: number;
  posterUrl: string | null;  // '/api/channels/7/poster' when a cover exists
  year: number | null;
  overview: string | null;
}
```

The contract lives in `src/shared/api-types.ts` and is mirrored in
`android/app/src/main/java/com/retrotv/app/net/Models.kt`.

## Settings screen

The web app has a settings screen, navigable entirely by remote control (arrow
keys / D-pad, no mouse or keyboard required), where the household can:

- Trigger a library rescan, either `incremental` (reuses the probe cached by
  each file's modified time and size — the same thing the daily rescan does)
  or `full` (reopens every file, for when the index itself looks wrong).
- Re-fetch cover art and synopsis, optionally wiping what is already stored
  first.
- Set audio and subtitle language preferences, and whether subtitles turn on
  automatically.
- Toggle smart grouping (see below) and automatic remux, and set the daily
  rescan time.

These preferences are saved on the server, not in the browser's
`localStorage`: the whole household shares one password and the same screens,
so picking "Portuguese audio" on the living-room TV has to hold on the tablet
too. Settings that also exist in `.env` (`SMART_GROUPING`, `AUTO_REMUX`,
`REMUX_CACHE_MAX_BYTES`,
`AUTO_THUMBS`, `RESCAN_TIME`) use the environment value as their default — saving in the
panel overrides it, and clearing a preference falls back to whatever `.env`
says.

| Route | Returns |
| --- | --- |
| `GET /api/settings` | `AppSettings` |
| `PATCH /api/settings` | `AppSettings`; body is a partial `SettingsPatch` — never a full replace, so two devices editing at once cannot erase each other's change |
| `GET /api/library/status` | `LibraryStatus` — scan/metadata/remux state, polled while a task runs |
| `POST /api/library/scan` | 202 once the scan is accepted, not once it finishes (14k files take minutes); 409 if one is already running |
| `POST /api/library/metadata` | 202 once the re-fetch is accepted, 409 if one is already running |

Full request/response shapes and status codes are in
[docs/CONTRACTS.md](docs/CONTRACTS.md).

## Library layout

Both shapes are understood, and a single series may mix them:

```
LIBRARY/
  Series Name/
    episode 01.mp4
    episode 02.mp4

  Other Series/
    1a Temporada/
      episode 01.mp4
    2a Temporada/
      episode 01.mp4
```

Deeper nesting works too — anything under a top level folder is collected
recursively and ordered by natural sort. Season folders are recognised in the
shapes that actually appear in the wild (`1a Temporada`, `Temporada 4`,
`Season 5`, `S06`, `T07`, `Terceira Temporada`). Season and episode numbers are
best effort: when a filename gives nothing reliable the fields stay null rather
than being invented.

Hidden files, `@eaDir`, `.AppleDouble` and `#recycle` are skipped. A series
whose files all fail to probe does not become a channel.

## Smart grouping

Release folders usually name each season on its own, for example:

```
Rick.and.Morty.S01.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA/
Rick.and.Morty.S02.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA/
```

**Before**, without grouping: each folder is its own channel, so this becomes
two channels, both named after the release —
`Rick.and.Morty.S01.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA` and
`Rick.and.Morty.S02.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA` — instead of one
show.

**After**, with `SMART_GROUPING` on (the default): folders belonging to the
same series are merged into a single channel, "Rick and Morty", carrying both
seasons. This applies to any series that follows the same per-season release
naming, not just this example.

If your library is already one folder per show, grouping has nothing to do —
set `SMART_GROUPING=false` and skip it.

**Turning grouping on for a library that is already indexed renames shows and
renumbers channels.** A channel's number is assigned once, the first time its
slug shows up, and the slug is derived from the show's name. When grouping
collapses two release folders into one differently-named series, that series
gets a new slug and a new channel number; the old numbers are not reused. If
anyone in the household has a channel number memorized, they will need to
relearn it after grouping is turned on.

## Codecs

There is no transcoding, so the client has to decode the source directly. AV1 in
MP4 decodes everywhere current; H.265 only plays where the OS exposes a hardware
decoder. Check your library before assuming:

```bash
npm run survey -- "/path/to/library"
```

It reports codec and container distribution, how many files carry the `moov`
atom up front, and a plain verdict on whether direct play is viable.

### Files no remux can fix

Remuxing copies bytes; it does not decode pictures. An older library with
MPEG-4 Part 2 (the DivX/XviD in `.avi` rips), MPEG-2 or WMV plays in no browser
at all, and changing the container does not change that. Those files are still
indexed and show up normally — they play in the Android app, and in the browser
the player says they need converting instead of showing "no signal".

Converting is yours to trigger, never automatic:

```bash
# Lists and measures. Converts NOTHING — this is the default.
npm run transcode-legacy -- "/path/to/library"

# Converts, writing "<name>.h264.mp4" alongside. The original is left alone.
npm run transcode-legacy -- "/path/to/library" --apply --limit 5

# Converts and replaces, keeping the originals so you can back out.
npm run transcode-legacy -- "/path/to/library" \
  --replace --keep-originals /mnt/tank/originals
```

An original is only retired after the converted file passes a check that decodes
both the start and the END of it — an interrupted ffmpeg produces an MP4 with the
right duration in its header and the last minutes missing. If the check fails,
the converted file is discarded and the original stays put.

Run the scan afterwards: the new file has a different name, and the index still
points at the old one.

## Requirements

- Node 22 or newer
- `ffmpeg`/`ffprobe` on the PATH — indexing and subtitle extraction
- A library of video files

## Quick start

```bash
npm install
cp .env.example .env

openssl rand -hex 32        # SESSION_SECRET
npm run hash-password       # AUTH_PASSWORD_HASH
```

Indexing is the only expensive step, since it runs `ffprobe` once per file. A
second run is nearly instant, because results are cached by modified time and
size:

```bash
npm run scan -- "/path/to/library"
```

You can skip it: when the index is empty the server indexes in the background
without delaying startup, which is the normal path in a container. Inside the
container the scan binary is the compiled one, since `tsx` does not ship in the
image:

```bash
docker compose exec widetv node dist/server/scan.js /media/biblioteca
```

Then:

```bash
npm run dev      # Vite on 5173, API on 8080
npm run build && npm start
```

## Configuration

| Variable | Meaning |
| --- | --- |
| `LIBRARY_ROOT` | Root folder of the library |
| `DATA_DIR` | SQLite index, covers and subtitle cache. Must be writable. Do not leave it blank: blank falls back to a relative path, which inside the container is `/app/data`, with no volume and no write permission |
| `AUTO_SCAN` | Indexes on its own when the index is empty. Only the exact string `false` turns it off |
| `RESCAN_TIME` | Daily library rescan at this LOCAL time (`HH:MM`, default `04:00`): adds new shows/episodes and removes deleted ones. `off` disables |
| `AUTO_REMUX` | Converts MKV/Dolby episodes to browser-safe MP4 in the background (byte copy, no transcode). Copies live in `DATA_DIR/remux` and take roughly the size of the MKVs themselves. Only the exact string `false` turns it off |
| `REMUX_CACHE_MAX_BYTES` | Disk budget for those generated copies, all of them combined. Over the cap, the least recently watched copy is deleted; the original file is never touched. Accepts a suffix (`20G`, `500MB`, `1T`) or a plain byte count. `0` means no cap. Default `20G` |
| `AUTO_THUMBS` | Grabs one frame per episode in the background, for the episode list and the catalog rails (no metadata provider has per-episode images for a home library). One ffmpeg per file, one at a time, yielding to the remux. JPEGs live in `DATA_DIR/thumbs`, around 30 KB each. Only the exact string `false` turns it off |
| `SMART_GROUPING` | Merges same-series release folders (e.g. `Show.S01...` + `Show.S02...`) into one channel — see [Smart grouping](#smart-grouping). On by default; only the exact string `false` turns it off. The settings panel can override this at runtime; clearing that override falls back to this value |
| `TMDB_API_KEY` | Optional. Puts TMDB first in the cover chain, with pt-BR synopses. Without it, TVMaze and iTunes are used |
| `PORT` | HTTP port, default 8080 |
| `CHANNEL_EPOCH` | Instant zero of the live schedule. Changing it moves every channel at once |
| `AUTH_PASSWORD_HASH` | Output of `npm run hash-password` |
| `SESSION_SECRET` | 32 bytes or more of randomness, signs the session cookie |
| `SECURE_COOKIES` | `false` only for local HTTP. Anything else keeps the `Secure` flag |

`.env` is read once, at startup. `npm run dev` watches it; a production
container needs `docker compose up -d --force-recreate`.

`AUTH_PASSWORD_HASH` holds the hash, not the password. Pasting the plain
password there makes the server refuse to start, and say so.

## Deploying

`docker compose up` builds and runs it with the library mounted read only and
the index on a named volume. See [docs/DEPLOY.md](docs/DEPLOY.md) for the
TrueNAS SCALE walkthrough and the reverse proxy configuration.

If you expose this beyond your LAN, put HTTPS in front of it. Without TLS the
password and the session cookie travel in clear text; the compose file publishes
to `127.0.0.1` by default for exactly that reason.

## Security

Access is a single password, hashed with scrypt and compared in constant time.
The session cookie is stateless, signed with HMAC-SHA256, `HttpOnly` and
`SameSite=Lax`, and carries its own issue time inside the signed payload so the
expiry cannot be moved by the client. Repeated failures from one address are
locked out for fifteen minutes.

This is a lock on a door, not a fortress. It suits a personal media server
behind a reverse proxy; it is not a multi-user authentication system.

## Project layout

```
src/
  shared/     API contract types, used by server and clients
  server/
    library/  scanner, ffprobe wrapper, SQLite index, scan job
    schedule/ clock.ts, the pure function behind the live grid
    channels/ maps the index onto channels, HTTP routes
    metadata/ cover and synopsis providers, background enrichment
    stream/   range parsing, file delivery, subtitle extraction
    auth/     password hashing, session cookie, routes
    cli/      scan, survey, hash-password
  web/        browser client
```

The interesting logic is deliberately pure and lives away from the I/O:
`clock.ts`, `range.ts` and the provider parsers have no filesystem and no
`Date.now()`.

## Tests

```bash
npm test
npm run typecheck
```

## Licence

No licence file yet. Add one before sharing this publicly if you care how others
may use it.
