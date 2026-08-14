# Retro TV

Turn a folder of cartoons into live TV channels.

Every series in your library becomes a channel that runs 24 hours a day, whether
or not anyone is watching. Opening a channel does not start an episode: it tunes
into whatever would be airing right now, mid scene, and keeps going into the next
episode when that one ends. There is no menu, no library grid and no "continue
watching". Just change the channel.

[Portugues](README.pt-BR.md)

![A channel playing, with the on screen display showing channel number, series and episode](docs/images/channel.jpg)

## How it works

The schedule is a pure function of the clock. Given a fixed epoch, the total
duration of a series and the current time, the server computes which episode is
airing and how far into it we are:

```
cycle   = sum of every episode duration
elapsed = (now - epoch) mod cycle
```

Nothing about playback position is stored. That has three useful consequences:

- Restarting the server does not disturb the grid. The epoch is the only state.
- Two people opening the same channel see the same frame.
- A channel that nobody watches for a week is exactly where it should be when
  someone finally tunes in.

Each channel is offset by a stable hash of its slug, so the channels are not all
sitting on episode 1 at the same instant.

The browser fetches the current position, measures the round trip to estimate
clock skew, seeks to the right offset, and then keeps itself honest. Every second
it compares the real playback position against the projected one:

| Drift | Correction |
| --- | --- |
| under 300 ms | none |
| 300 ms to 2 s | playback rate nudged by 5 percent until it closes |
| over 2 s | hard seek |

Fifteen seconds before an episode ends, the next one is preloaded into a second
video element, and the swap is a visibility change rather than a reload. No black
gap between episodes.

Measured on a real 460 channel library: drift held at 163 ms plus or minus 5 ms
over 30 seconds, well inside the deadband.

## Look

The CRT treatment is CSS and SVG layered over a native `<video>` element. No
WebGL, no canvas. That keeps the video element real, which matters for the
planned Android client, and it costs almost nothing on the client GPU.

Layers, in order: scanlines, phosphor mask, roll bar, vignette, animated grain
via `feTurbulence`, brightness flicker, glass reflection. Everything is driven by
custom properties on `:root`, so it is tunable without touching the rules:

```css
--crt-scanline-opacity
--crt-mask-opacity
--crt-grain-opacity
--crt-flicker-amount
--crt-vignette
--crt-phosphor      /* default #33ff66 */
```

Adding `.crt-off` to the container disables every effect at once.
`prefers-reduced-motion` disables the flicker and the animated grain.

The picture fills the full height of the window at 4:3. On a 16:9 television that
leaves black bars on the sides, which is correct: nothing is stretched and nothing
is cropped.

![A dark scene showing the scanlines, phosphor mask and vignette over the picture](docs/images/crt-detail.jpg)

## Controls

There is no menu anywhere, so the login screen doubles as the control reference.

| Key | Action |
| --- | --- |
| Up / Down | previous or next channel, wrapping around |
| 0 to 9 | tune directly by number |
| Left / Right | volume |
| M | mute |

Typing digits behaves like an old remote: the number is held briefly before it
commits, and commits immediately once it reaches the width of the highest channel
number.

The last channel you watched is kept in `localStorage`, so closing the browser
and coming back later drops you on the same channel rather than back at channel
one. It is validated against the channels that exist at that moment: if the
series was removed from the library in the meantime, you land on the first
channel instead of a dead screen. This is the only thing the app remembers
between sessions.

![Login screen showing the password prompt and the keyboard reference](docs/images/login.jpg)

### Autoplay

The picture always starts on its own. Sound is a different matter: browsers
refuse to play audio before the user has interacted with the page, and that rule
cannot be worked around from JavaScript.

So the player tries with sound, and if the browser refuses it starts muted
immediately rather than leaving a still frame on screen. The first key press or
click restores the sound. A short `SEM SOM` notice appears when that happens.

On a machine dedicated to this, launch the browser with the policy disabled and
sound works from the first frame with no interaction at all:

```
chromium --kiosk --autoplay-policy=no-user-gesture-required http://your-host/
```

Chrome also grants autoplay by itself once you have watched enough on a given
origin, so a browser you use regularly stops asking after a while.

## Library layout

Both of these are understood, and a single series may mix them:

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

Deeper nesting also works. Anything below a top level folder is collected
recursively and ordered by natural sort of the path, so a boxed set with sub
collections becomes one channel rather than several.

Season folders are recognised in the shapes that actually appear in the wild,
including the Portuguese convention where the number comes first:
`1a Temporada`, `2 Temporada`, `1a.Temporada.1959-1960`, `10a Season`,
`Temporada 4`, `Season 5`, `S06`, `T07`, and written ordinals such as
`Terceira Temporada`.

Episode and season numbers are best effort. When a filename gives nothing
reliable the fields stay null rather than being invented, since the position in
the grid is what actually drives playback.

Hidden files, `@eaDir`, `.AppleDouble` and `#recycle` are skipped. A series whose
files all fail to probe does not become a channel, because an empty channel would
divide the schedule by zero.

## Codecs

There is no transcoding. Files are served straight from disk with HTTP range
requests, which is the only sane choice on a NAS without a GPU.

That works because the browser is expected to decode the source directly. AV1 in
MP4 decodes in software on every current Chrome and natively on Android. H.265
only plays where the operating system exposes a hardware decoder, so an H.265
heavy library may not survive direct play on every client.

Check yours before assuming:

```
npm run survey -- "/path/to/library"
```

It reports the codec distribution, the container distribution, how many files
carry the `moov` atom up front (which is what makes seeking into the middle of a
file fast), and a plain verdict on whether direct play is viable.

## Requirements

- Node 22 or newer
- `ffprobe` on the PATH, for indexing
- A library of video files

## Quick start

```bash
npm install
cp .env.example .env
```

Generate the two secrets and put them in `.env`:

```bash
openssl rand -hex 32        # SESSION_SECRET
npm run hash-password       # AUTH_PASSWORD_HASH
```

Index the library. This is the only expensive step, since it runs `ffprobe` once
per file. A second run is nearly instant because results are cached by modified
time and size:

```bash
npm run scan -- "/path/to/library"
```

You can skip that command if you want to. When the index is empty the server
indexes the library by itself, in the background, without delaying startup. That
is the normal path for a container deployment, where there is no shell to run
commands in. Inside a container the scan binary is the compiled one, since `tsx`
is a development dependency and does not ship in the image:

```bash
docker compose exec retro-tv node dist/server/scan.js /media/desenhos
```

Then run it:

```bash
npm run dev      # Vite on 5173, API on 8080
```

For production:

```bash
npm run build
npm start
```

## Configuration

| Variable | Meaning |
| --- | --- |
| `LIBRARY_ROOT` | Root folder of the library |
| `DATA_DIR` | Where the SQLite index lives. Must be writable. Do not leave it blank: blank falls back to a relative path, which inside the container is `/app/data`, with no volume and no write permission |
| `AUTO_SCAN` | Indexes the library on its own when the index is empty. Only the exact string `false` turns it off |
| `DISPLAY_MODE` | `crt` (default) keeps the 4:3 CRT look. `widescreen` switches clients to 16:9 without the CRT filter, with a channel list plus an on-demand catalogue — for FullHD/4K libraries |
| `PORT` | HTTP port, default 8080 |
| `CHANNEL_EPOCH` | Instant zero of the schedule. Changing it moves every channel at once |
| `AUTH_PASSWORD_HASH` | Output of `npm run hash-password` |
| `SESSION_SECRET` | 32 bytes or more of randomness, signs the session cookie |
| `SECURE_COOKIES` | `false` only for local HTTP. Anything else keeps the `Secure` flag |

`.env` is read once, at startup. Changing the password in the file does nothing
until the process restarts, which looks exactly like a wrong password in the UI.
`npm run dev` watches `.env` and restarts for you; a production container needs
`docker compose up -d --force-recreate`.

`AUTH_PASSWORD_HASH` holds the hash, not the password. Pasting the plain password
there used to produce a server that started fine and then rejected the correct
password, so the server now refuses to start and says so.

## Deploying

`docker compose up` builds and runs it with the library mounted read only and the
index on a named volume. See [docs/DEPLOY.md](docs/DEPLOY.md) for the TrueNAS
SCALE walkthrough and the reverse proxy configuration.

One thing worth repeating here: if you expose this beyond your LAN, put HTTPS in
front of it. Without TLS the password and the session cookie travel in clear text.
The compose file publishes to `127.0.0.1` by default for exactly that reason.

## Security

Access is a single password, hashed with scrypt and compared in constant time.
The session cookie is stateless, signed with HMAC-SHA256, `HttpOnly` and
`SameSite=Lax`, and carries its own issue time inside the signed payload so the
expiry cannot be moved by the client. Repeated failures from one address are
locked out for fifteen minutes.

This is a lock on a door, not a fortress. It is appropriate for a personal media
server behind a reverse proxy. It is not an authentication system for multiple
users, and it does not pretend to be.

## Project layout

```
src/
  shared/     API contract types, used by server and client
  server/
    library/  scanner, ffprobe wrapper, SQLite index, scan job
    schedule/ clock.ts, the pure function behind the whole thing
    channels/ maps the index onto channels, HTTP routes
    stream/   range parsing and file delivery
    auth/     password hashing, session cookie, routes
    cli/      scan, survey, hash-password
  web/
    sync.ts   clock skew and drift correction, pure
    tuner.ts  keyboard to channel number, pure reducer
    player.ts video elements, preload and swap
    crt/      the CRT skin
```

The interesting logic is deliberately pure and lives away from the I/O:
`clock.ts`, `sync.ts`, `tuner.ts`, `osd.ts` and `range.ts` have no filesystem, no
DOM and no `Date.now()`. That is what makes the schedule testable at its edges,
which is where a live grid actually breaks.

## Tests

```bash
npm test
npm run typecheck
```

382 tests. The clock is covered at every boundary that matters: the exact instant
between two episodes, the loop wrap, an epoch in the future, a one episode series,
and a 300 episode cycle running for several laps.

## Android

Not built yet. The client keeps no business state and the API is the only source
of truth, so the path is either wrapping the web client or writing a native
client against the same endpoints. Nothing in the API is browser specific.

## Licence

No licence file yet. Add one before sharing this publicly if you care how others
may use it.
