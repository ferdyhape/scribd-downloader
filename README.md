# Scribd Reader

A reader for **publicly viewable** Scribd documents that renders the document
in its own styling and offers a PDF underneath. Nothing is uploaded anywhere,
and there's no hosted version of this — you run it yourself, one of two ways:

- **This local web app** (below) — a small Node.js server you run on your own
  machine, opened in your browser like any local dev tool.
- **The browser extension** (see [`extension/`](extension/README.md)) — no
  server at all; it runs entirely inside your own browser tab.

Pick whichever fits how you work. The extension is the lighter option (nothing
to install beyond the browser itself); the web app is the one this README
covers in detail.

> A prior version of this project was written in Python (Playwright + Flask).
> It's still in git history if you ever need to compare the two:
> `git log --all --oneline -- scribd_dl.py app.py`.

## Scope, stated plainly

This renders what a normal browser can already see on a public document. It
does **not** sign in, does **not** forge Scribd's challenge tokens, and does
**not** unlock paywalled or subscriber-only pages — those pages come back
reported as `locked` rather than fetched. For anything beyond a public
document — full library access, downloads, subscriptions, supporting the
people who upload — [scribd.com](https://www.scribd.com) is the real place
for that; this tool doesn't try to replace it.

## Setup

Requires Node.js 20.12+ and an installed **Chrome or Edge** — this drives a
browser already on your machine rather than downloading its own (see
[Why Node](#why-node) for the reasoning; it's most of why the whole thing is
light).

```bash
npm install
npm start
```

Open <http://127.0.0.1:5000>, paste a link, and go. First open of a document
takes fifteen seconds to a minute; after that it's instant and served straight
from cache.

You can also swap the host in your address bar, the way the hosted tools do:

```
https://www.scribd.com/document/546176019/Some-Slug
      → http://127.0.0.1:5000/document/546176019/Some-Slug
```

### Configuration

None of this is required, everything has a working default. Copy
`.env.example` to `.env` and adjust whatever you need:

```bash
cp .env.example .env
```

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `5000` | Where the server listens |
| `HEADLESS` | `1` | Set to `0` once if Scribd's bot check won't clear on its own; a visible window can get past it, and the profile remembers it afterward |
| `SCRIBD_DL_CHANNEL` | auto-detect | Force `chrome` or `msedge` instead of trying both |
| `SCRIBD_DL_EXECUTABLE` | unset | Point at a specific Chromium-based binary instead |
| `CAPTURE_TIMEOUT_SECONDS` | `120` | How long to wait for a document to finish rendering |
| `CACHE_DIR` | `cache` | Where rendered documents are stored |
| `PROFILE_DIR` | `.profile` | Where the browser profile lives |
| `CLEANUP_MAX_AGE_HOURS` | `24` | Default age `/admin/cleanup` removes, see below |
| `CLEANUP_TOKEN` | unset | Require this back from `/admin/cleanup` callers |

`CACHE_DIR` and `PROFILE_DIR` are worth pointing at a persistent volume if
this ever runs somewhere with ephemeral local storage.

## How it works

Scribd sits behind a bot challenge that plain HTTP requests can't get past —
so this drives an actual browser, which clears it the ordinary way, by being
one. Once the page is open, a document turns out to be real HTML text
(positioned spans, real webfonts) rather than a picture of a page, which is
what makes an exact, selectable, searchable copy possible at all.

Getting that copy to actually *look* like the source took more than copying
markup and CSS — Scribd styles pages through wrapper classes and design tokens
that don't travel with a plain copy-paste, and its document fonts are loaded
through JavaScript rather than stylesheets, so naive copies fall back to
system fonts and look subtly wrong. All of that is handled in
[`lib/capture.js`](lib/capture.js) and [`lib/inject.js`](lib/inject.js), with
the reasoning written out in the comments for anyone curious.

## What runs where

The capture step — opening Scribd, reading the page — has to happen
server-side; a browser tab visiting this app can't reach across to Scribd's
origin itself (that's just how the web's cross-origin rules work). But once a
document is captured, it's a fully self-contained file with every font, image
and style baked in — so from that point on, your browser does all the work of
actually rendering it, and repeat visits are served straight from your
browser's own cache without touching the server again.

## Cleaning up

Every document opened gets saved under `cache/<id>/`, and nothing removes
those on its own. `POST /admin/cleanup` clears out anything older than a
threshold (default 24 hours):

```bash
curl -X POST "http://127.0.0.1:5000/admin/cleanup?maxAgeHours=24"
```

That's meant to be called from a daily cron rather than run inside the app
(a timer here would just restart every time the server restarts). A crontab
entry for once a day:

```
0 3 * * * curl -fsS -X POST "http://127.0.0.1:5000/admin/cleanup" > /dev/null
```

It only ever touches its own `cache/` folder. If this server is ever reachable
by anything other than your own cron, set `CLEANUP_TOKEN` and pass it back as
either `?token=` or an `X-Cleanup-Token` header, otherwise the endpoint is
open to anything that can reach the port.

## Why Node

The previous version was Python, but Playwright's Python package quietly
carries its own bundled Node.js runtime just to talk to the browser — so
Python was, in effect, a layer sitting on top of Node already. Cutting it out
was a straightforward simplification, not a rewrite for its own sake.

This build also drives a browser you already have (Chrome or Edge) instead of
downloading one — Playwright's own bundled Chromium runs into the hundreds of
megabytes, which is pure waste on a machine that already has a browser
installed. If neither is found, it says so clearly rather than failing
strangely. Point `SCRIBD_DL_CHANNEL` at `chrome` or `msedge` to force one, or
`SCRIBD_DL_EXECUTABLE` at a specific binary.

## Files

```
server.js      The web app: paste box, reader, PDF route, disk cache
lib/
  capture.js   Capture engine — page loading, offline copy assembly, PDF export
  inject.js    The small pieces of logic that run inside the page itself
  browser.js   Picks a browser to drive without downloading one
cache/         Rendered documents live here once opened
.profile/      Browser profile, kept around so the bot check only happens once
extension/     The browser-extension alternative — see its own README
```
