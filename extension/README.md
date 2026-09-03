# Scribd Reader (Chrome Extension)

A lightweight browser extension for reading public Scribd documents without
the blur/paywall overlay, and for opening a clean, high-fidelity standalone
copy — **entirely client-side, with zero server load**.

---

## Features

1. **Zero server load** — the whole rendering process runs on your own
   CPU/RAM. Nothing is uploaded, nothing runs on a server anywhere.
2. **No bot-challenge problem** — it runs inside your own real browser, so it
   never runs into Scribd's Cloudflare/bot checks the way a server-side
   scraper would.
3. **Open Clean Copy** — opens the document in a new tab: a clean, standalone
   copy, with the real page images and fonts inlined. That tab has two real
   download actions:
   - **Download HTML** — saves the exact, self-contained file to disk.
   - **Download PDF** — opens the document as its own separate tab and prints
     that tab directly, so what you see is exactly what gets printed.
4. **Unlock & Clean Tab** — removes blur and promotional overlays directly on
   the Scribd tab you're already reading, and enables text selection there.

---

## Installation (Chrome / Edge / Brave)

Takes about 15 seconds:

1. Open your browser (Chrome, Edge, or Brave).
2. Go to:
   - **Chrome / Brave:** `chrome://extensions/`
   - **Microsoft Edge:** `edge://extensions/`
3. Turn on **"Developer mode"** in the top-right corner.
4. Click **"Load unpacked"** in the top-left corner.
5. Select this **`extension`** folder.
6. Done — the Scribd Reader icon appears in your browser's extension bar.

---

## Usage

1. Open any public document on [scribd.com](https://www.scribd.com) (for
   example `https://www.scribd.com/document/...`).
2. Click the **Scribd Reader** icon in your browser toolbar.
3. Pick an action:
   - **Open Clean Copy** — the extension auto-scrolls the page to load every
     image, then opens a clean, standalone copy in a new tab, with Download
     HTML and Download PDF buttons right there.
   - **Unlock & Clean Tab** — removes blur and promo banners directly on the
     page you're currently reading.

---

## Scope

**Open Clean Copy** only reads what a normal browser already shows on a
public document — it does not sign in, and it never touches pages Scribd
withholds. **Unlock & Clean Tab** is different: it also removes Scribd's own
blur/paywall overlay on the tab you're viewing, so be aware of that
distinction before relying on it.

For anything beyond a public document — full library access, downloads,
subscriptions, supporting the people who upload —
[scribd.com](https://www.scribd.com) is the real place for that.
