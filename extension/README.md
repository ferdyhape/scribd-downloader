# Scribd Downloader (Chrome Extension)

Reads public Scribd documents without the blur/paywall overlay, and opens a
clean, high-fidelity standalone copy — **entirely client-side, zero server**.

## Features

- **Zero server** — runs on your own CPU/RAM, nothing uploaded anywhere.
- **No bot-challenge problem** — it's just your own browser, so it never
  trips Scribd's Cloudflare/bot checks the way a server-side scraper would.
- **Open Clean Copy** — opens the document in a new tab with real fonts and
  images inlined, plus Download HTML and Download PDF buttons.
- **Unlock & Clean Tab** — removes blur/promo overlays on the Scribd tab
  you're already reading, and enables text selection there.

## Installation (Chrome / Edge / Brave)

**Option A — packaged file (fastest):**

1. Go to `chrome://extensions` (`edge://extensions` on Edge).
2. Turn on **Developer mode** (top-right).
3. Drag [`extension.crx`](../extension.crx) onto that page.

If your browser refuses the drag-and-drop, fall back to Option B.

**Option B — load unpacked (always works):**

1. Download [`scribd-downloader.zip`](../scribd-downloader.zip) and unzip it
   (or just clone this repo).
2. Go to `chrome://extensions`, turn on **Developer mode**.
3. Click **Load unpacked**, select the `extension` folder.

Either way, done in about 15 seconds — the icon appears in your toolbar.

## Usage

1. Open any public document on [scribd.com](https://www.scribd.com).
2. Click the **Scribd Downloader** icon in your toolbar.
3. Pick an action:
   - **Open Clean Copy** — standalone copy in a new tab, Download HTML/PDF
     right there.
   - **Unlock & Clean Tab** — removes blur/promo banners on the current page.

## Scope

**Open Clean Copy** only reads what a normal browser already shows on a
public document — it does not sign in, and it never touches pages Scribd
withholds. **Unlock & Clean Tab** is different: it also removes Scribd's own
blur/paywall overlay on the tab you're viewing, so be aware of that
distinction before relying on it.

For anything beyond a public document — full library access, downloads,
subscriptions, supporting the people who upload —
[scribd.com](https://www.scribd.com) is the real place for that.
