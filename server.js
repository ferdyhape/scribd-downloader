#!/usr/bin/env node
/**
 * Local web front end for the capture engine.
 *
 * Paste a Scribd URL, the server renders the document once with a real
 * browser, and shows it to you in the page - in the document's own styling -
 * with a download button underneath. Runs on your machine; nothing is
 * uploaded anywhere.
 *
 *   node server.js            # then open http://127.0.0.1:5000
 *
 * Scope: renders what a normal browser can already see on a publicly viewable
 * document. It does not sign in and does not unlock paywalled pages; pages
 * Scribd withholds are reported as locked.
 *
 * Env:
 *   HEADLESS=0    run the capture browser with a visible window. Use this
 *                 once if Scribd's bot challenge will not clear on its own.
 *   PORT=5000
 */

import compression from 'compression';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { captureDocument, renderPdf, safeName } from './lib/capture.js';

// Number(x) || fallback would silently discard a legitimate "0" (0 is
// falsy), which matters for CLEANUP_MAX_AGE_HOURS=0 ("wipe everything").
// Only fall back when the variable is genuinely unset.
function numEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const CACHE = path.resolve(process.env.CACHE_DIR || 'cache');
fs.mkdirSync(CACHE, { recursive: true });

const HEADLESS = process.env.HEADLESS !== '0';
const DEFAULT_CLEANUP_MAX_AGE_HOURS = numEnv('CLEANUP_MAX_AGE_HOURS', 24);

// The capture uses one shared browser profile directory, so renders are
// serialised rather than run concurrently. A single in-process promise chain
// is enough here (one process, one worker) - see the README for why this
// would need to change before a multi-worker deploy.
let renderChain = Promise.resolve();
function withRenderLock(fn) {
  const next = renderChain.then(fn, fn);
  renderChain = next.catch(() => {});
  return next;
}

// Tracks documents currently being captured, so a request for a page that
// isn't ready yet gets an immediate response (a loading screen) instead of
// blocking the connection for however long the capture takes. The client
// then polls /status/:id and reloads once it settles. Errors are kept here
// too, so a failed capture is reported instead of retried in a loop.
const pending = new Map(); // id -> { error? }

function kickOff(id, url) {
  if (pending.has(id)) return;
  pending.set(id, {});
  ensureRendered(id, url)
    .then(() => pending.delete(id))
    .catch((err) => pending.set(id, { error: err }));
}

const app = express();
app.disable('x-powered-by');
app.use(compression()); // the captured HTML inlines every asset as base64 and can run into the MBs; this cuts real transfer time
app.use(express.urlencoded({ extended: false }));

const PUBLIC = path.resolve('public');
fs.mkdirSync(PUBLIC, { recursive: true });
app.use(express.static(PUBLIC, { maxAge: '1d' }));

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

const docDir = (id) => path.join(CACHE, id);

function readMeta(id) {
  const f = path.join(docDir(id), 'meta.json');
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch {
    return null;
  }
}

const DOC_ID_RE = /scribd\.com\/(?:document|doc|presentation|book)\/(\d+)/i;

function parseDocId(raw) {
  const s = String(raw || '').trim();
  if (/^\d+$/.test(s)) return s;
  const m = DOC_ID_RE.exec(s);
  return m ? m[1] : null;
}

/** Render the document if it is not cached yet; return its metadata. */
async function ensureRendered(id, sourceUrl) {
  const d = docDir(id);
  let meta = readMeta(id);
  if (meta && fs.existsSync(path.join(d, 'doc.html'))) return meta;

  return withRenderLock(async () => {
    meta = readMeta(id); // another request may have won the race
    if (meta && fs.existsSync(path.join(d, 'doc.html'))) return meta;
    const { html, meta: newMeta } = await captureDocument(sourceUrl, {
      headless: HEADLESS,
      quiet: true,
    });
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'doc.html'), html, 'utf-8');
    newMeta.id = id;
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(newMeta, null, 2), 'utf-8');
    return newMeta;
  });
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const FOOTER = `
<footer class="site-footer">
  <div class="footer-inner">
    by <a href="https://ferdyhape.com" target="_blank" rel="noopener">ferdyhape.com</a>
  </div>
</footer>`;

const BRAND_MARK_SVG = `<svg viewBox="0 0 64 64" width="23" height="23" aria-hidden="true" style="display:block;border-radius:6px;overflow:hidden">
  <defs>
    <linearGradient id="bmBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#347d57"/>
      <stop offset="100%" stop-color="#1b4d35"/>
    </linearGradient>
    <linearGradient id="bmFold" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#a8dec2"/>
      <stop offset="100%" stop-color="#6ec599"/>
    </linearGradient>
    <linearGradient id="bmS" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2a6d4b"/>
      <stop offset="100%" stop-color="#194830"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#bmBg)"/>
  <rect x="14" y="11" width="34" height="42" rx="4" fill="#e2f4ea" fill-opacity="0.28" transform="rotate(-6 31 32)"/>
  <path d="M17 12 h19 l12 12 v25 a3.5 3.5 0 0 1 -3.5 3.5 h-24 a3.5 3.5 0 0 1 -3.5 -3.5 v-33.5 a3.5 3.5 0 0 1 3.5 -3.5 z" fill="#ffffff"/>
  <path d="M36 12 v9 a3 3 0 0 0 3 3 h9 z" fill="url(#bmFold)"/>
  <path d="M26 25.5 c2.5 -2.2 7 -2.4 9.5 -0.4 c2.2 1.6 2 4.4 0.2 5.8 c-3.2 2.5 -7.2 3.1 -7.2 6.8 c0 2.8 2.8 4.5 6.8 4.1 c2.2 -0.2 4.4 -1.1 5.7 -2.2" fill="none" stroke="url(#bmS)" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="38.5" cy="40.2" r="1.8" fill="#347d57"/>
</svg>`;

const BRAND_HEADER = `<a class="brand" href="/"><span class="mark">${BRAND_MARK_SVG}</span>Scribd Reader</a>`;

const SHELL = (title, body, { bodyClass = '' } = {}) => {
  const pageTitle = title && title !== 'Scribd Reader' ? `${title} - Scribd Reader` : 'Scribd Reader';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pageTitle)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="alternate icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="alternate icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="shortcut icon" href="/favicon.ico">
<style>
  :root{
    --bg:#f7f7f5; --surface:#ffffff; --fg:#17171a; --mut:#6b6b68; --line:#e5e5e1;
    --accent:#2f6f4e; --accent-fg:#ffffff;
    --danger:#b3453b; --danger-bg:#fbeceb;
    --radius:10px;
    --shadow:0 1px 2px rgba(20,20,15,.04), 0 8px 24px -12px rgba(20,20,15,.10);
  }
  /* Always light, on purpose: one consistent look regardless of the
     visitor's OS/browser theme, so the branding never surprises anyone. */
  html{color-scheme:light}
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0; background:var(--bg); color:var(--fg);
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,ui-sans-serif,sans-serif;
    display:flex; flex-direction:column;
  }
  a{color:inherit}
  /* Fixed height, no wrapping: home and viewer share this bar, and the
     viewer iframe below it is sized against this exact number, so the two
     pages must never be allowed to disagree on how tall it is. */
  .topbar{
    height:60px; padding:0 18px; border-bottom:1px solid var(--line); overflow:hidden;
    display:flex; align-items:center;
  }
  .topbar-inner{
    max-width:620px; width:100%; margin:0 auto;
    display:flex; align-items:center; gap:14px; height:100%;
  }
  .topbar .brand{
    display:flex; align-items:center; gap:9px; font-weight:700; letter-spacing:-.01em;
    text-decoration:none; color:var(--fg); font-size:15px; flex-shrink:0;
  }
  .topbar .brand .mark{
    width:24px; height:24px; border-radius:7px;
    display:flex; align-items:center; justify-content:center;
    flex-shrink:0;
  }
  .topbar .doc-meta{color:var(--mut); font-size:13px; overflow:hidden; text-overflow:ellipsis;
    white-space:nowrap; display:flex; align-items:center; gap:7px; min-width:0}
  .topbar .spacer{flex:1; min-width:8px}
  .topbar .btn{padding:8px 15px; font-size:13.5px; flex-shrink:0}
  .dot{width:6px; height:6px; border-radius:999px; flex-shrink:0; background:var(--mut)}
  .dot.warn{background:#c98a2c}
  body.viewer .topbar{
    padding:0 22px;
  }
  body.viewer .topbar-inner{
    max-width:none;
  }
  @media (max-width:520px){
    .topbar .doc-meta{display:none}
  }
  /* Mobile-first base styles (< 600px) */
  main.page{
    flex:1; width:100%; display:flex; flex-direction:column;
    justify-content:center; padding:24px 18px;
  }
  .center-container{
    width:100%; max-width:620px; margin:0 auto;
    display:flex; flex-direction:column;
  }
  .hero{width:100%}
  .hero h1{
    font-size:23px; line-height:1.24; margin:0 0 10px;
    letter-spacing:-.02em; font-weight:700;
  }
  .hero p.sub{
    color:var(--mut); margin:0 0 20px; font-size:14.5px; line-height:1.55;
  }
  form.grab{
    display:flex; flex-direction:column; gap:8px; width:100%;
  }
  input[type=text]{
    width:100%; min-width:0; padding:12px 14px; border:1px solid var(--line);
    border-radius:var(--radius); background:var(--surface); color:var(--fg); font:inherit;
    box-shadow:var(--shadow);
  }
  input[type=text]:focus{outline:2px solid var(--accent); outline-offset:1px}
  button, .btn{
    padding:12px 20px; border:1px solid transparent; border-radius:var(--radius);
    background:var(--accent); color:var(--accent-fg); font:inherit; font-weight:600; cursor:pointer;
    text-decoration:none; display:inline-flex; align-items:center; justify-content:center;
    gap:8px; white-space:nowrap;
    transition:opacity 120ms ease, transform 120ms ease;
  }
  button:hover, .btn:hover{opacity:.88}
  button:active, .btn:active{transform:translateY(1px)}
  button:disabled{opacity:.6; cursor:default; transform:none}
  .btn.ghost{background:transparent; color:var(--fg); border-color:var(--line)}
  .note{
    margin-top:16px; padding:12px 14px; border:1px solid var(--line); border-radius:var(--radius);
    color:var(--mut); font-size:13px; background:var(--surface);
  }
  .note.err{border-color:var(--danger); color:var(--danger); background:var(--danger-bg)}
  .hint{
    margin-top:24px; color:var(--mut); font-size:13px; line-height:1.5;
  }
  .hint a{color:var(--accent); font-weight:600; text-decoration:none}
  .hint a:hover{text-decoration:underline}
  .viewer-frame{border:0; width:100%; display:block; height:calc(100dvh - 61px)}
  .load-bar{position:sticky; top:0; left:0; height:2px; z-index:5;
    background:linear-gradient(90deg, transparent, var(--accent), transparent);
    background-size:200% 100%; animation:loadbar 1.1s linear infinite}
  @keyframes loadbar{0%{background-position:200% 0}100%{background-position:-200% 0}}
  .site-footer{
    padding:14px 18px; border-top:1px solid var(--line); color:var(--mut); font-size:12px;
  }
  .footer-inner{
    max-width:620px; width:100%; margin:0 auto;
    display:flex; align-items:center; justify-content:center; gap:5px;
  }
  .site-footer a{text-decoration:none; font-weight:600; color:var(--fg)}
  .site-footer a:hover{text-decoration:underline; color:var(--accent)}
  body.viewer .site-footer{display:none}

  /* Desktop & Tablet styles (>= 600px) */
  @media (min-width:600px){
    .topbar{
      padding:0 24px;
    }
    main.page{
      padding:36px 24px;
      align-items:center;
    }
    .center-container{
      max-height:560px;
      justify-content:center;
    }
    .hero h1{
      font-size:29px; line-height:1.22; margin:0 0 10px;
    }
    .hero p.sub{
      font-size:16px; margin:0 0 26px;
    }
    form.grab{
      flex-direction:row; flex-wrap:nowrap;
    }
    input[type=text]{
      flex:1; min-width:240px; padding:13px 15px;
    }
    button, .btn{
      width:auto; padding:13px 22px;
    }
    .hint{
      margin-top:30px; font-size:13.5px;
    }
    .site-footer{
      padding:16px 24px; font-size:12.5px;
    }
    .footer-inner{
      justify-content:flex-end;
    }
  }

  /* Wide & tall screens */
  @media (min-width:900px) and (min-height:750px){
    .center-container{
      max-height:500px;
    }
  }
  @media (prefers-reduced-motion:no-preference){
    .enter{animation:enter 260ms ease both}
  }
  @keyframes enter{from{opacity:0; transform:translateY(6px)} to{opacity:1; transform:translateY(0)}}
  .spinner{
    width:34px; height:34px; border-radius:999px; border:3px solid var(--line);
    border-top-color:var(--accent); animation:spin .8s linear infinite; margin:0 auto 22px;
  }
  @keyframes spin{to{transform:rotate(360deg)}}
  .status{max-width:440px; margin:auto; padding:48px 24px; text-align:center}
  .status h1{font-size:19px; margin:0 0 8px; font-weight:650}
  .status p{color:var(--mut); margin:0; font-size:14.5px}
  .status .actions{margin-top:22px; display:flex; gap:8px; justify-content:center}
</style></head>
<body class="${bodyClass}">${body}</body></html>`;
};

function homeBody({ error, prefill }) {
  return `
<header class="topbar">
  <div class="topbar-inner">
    ${BRAND_HEADER}
  </div>
</header>
<main class="page">
  <div class="center-container enter">
    <div class="hero">
      <h1>Read any public Scribd doc, no account needed</h1>
      <p class="sub">Drop a link in and it opens right here, looking just like the
        original. Save it as a PDF whenever you're ready.</p>
      <form class="grab" method="post" action="/fetch">
        <input type="text" name="url" placeholder="https://www.scribd.com/document/&hellip;"
               value="${esc(prefill)}" autofocus>
        <button type="submit">Open</button>
      </form>
      ${error ? `<div class="note err">${esc(error)}</div>` : ''}
    </div>
    <div class="hint">
      This only works with stuff that's already public on Scribd, it won't get
      you past a paywall or a sign-in wall. For the full library, offline
      access, or to support the people who upload, head over to
      <a href="https://www.scribd.com" target="_blank" rel="noopener">scribd.com</a>.
    </div>
  </div>
</main>
${FOOTER}`;
}

function viewBody(meta) {
  const lockedNote = meta.locked?.length
    ? `<span class="dot warn"></span>${meta.locked.length} page${meta.locked.length === 1 ? '' : 's'} locked`
    : `<span class="dot"></span>${meta.pages} page${meta.pages === 1 ? '' : 's'}`;
  const pdfName = esc(safeName(meta.title) + '.pdf');
  return `
<header class="topbar">
  <div class="topbar-inner">
    ${BRAND_HEADER}
    <span class="doc-meta">${esc(meta.title)} &middot; ${lockedNote}</span>
    <span class="spacer"></span>
    <button class="btn" id="pdfBtn" type="button" title="Save as PDF directly using your browser">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
      Save as PDF
    </button>
  </div>
</header>
<div class="load-bar" id="loadBar"></div>
<iframe class="viewer-frame" src="/raw/${meta.id}"
  onload="document.getElementById('loadBar').remove()"></iframe>
<script>
(function () {
  var btn = document.getElementById('pdfBtn');
  var frame = document.querySelector('.viewer-frame');
  if (!btn || !frame) return;

  btn.addEventListener('click', function (e) {
    e.preventDefault();
    try {
      if (frame.contentWindow) {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        return;
      }
    } catch (err) {
      console.warn('Direct frame print failed, falling back to new window:', err);
    }
    window.open(frame.src, '_blank');
  });
})();
</script>`;
}

function loadingBody(id) {
  return `
<header class="topbar">
  <div class="topbar-inner">
    ${BRAND_HEADER}
  </div>
</header>
<main class="page">
  <div class="status enter">
    <div class="spinner"></div>
    <h1>Opening your document</h1>
    <p>This takes a little while the first time, usually under a minute.</p>
  </div>
</main>
<script>
(function () {
  var id = ${JSON.stringify(id)};
  function poll() {
    fetch('/status/' + id)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === 'ready' || d.status === 'error') location.reload();
        else setTimeout(poll, 1300);
      })
      .catch(function () { setTimeout(poll, 2000); });
  }
  setTimeout(poll, 1300);
})();
</script>`;
}

function errorBody(id, message) {
  return `
<header class="topbar">
  <div class="topbar-inner">
    ${BRAND_HEADER}
  </div>
</header>
<main class="page">
  <div class="status enter">
    <h1>That one didn't work out</h1>
    <p>${esc(message || 'Something went wrong while opening this document.')}</p>
    <div class="actions">
      <a class="btn ghost" href="/">Back home</a>
      <a class="btn" href="/view/${id}?retry=1">Try again</a>
    </div>
  </div>
</main>`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  res.send(SHELL('Scribd Reader', homeBody({ error: req.query.error, prefill: req.query.url || '' })));
});

app.post('/fetch', (req, res) => {
  const raw = req.body.url || '';
  const id = parseDocId(raw);
  if (!id) {
    return res.redirect(
      `/?${new URLSearchParams({ url: raw, error: "That doesn't look like a Scribd link. Paste the full URL and try again." })}`
    );
  }
  res.redirect(`/view/${id}`);
});

// Mirrors Scribd's own path shape, so you can swap the host in the address bar.
app.get(['/document/:id', '/document/:id/:slug', '/doc/:id', '/doc/:id/:slug'], (req, res) => {
  res.redirect(`/view/${req.params.id}`);
});

app.get('/view/:id', (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) return res.sendStatus(404);

  const meta = readMeta(id);
  if (meta && fs.existsSync(path.join(docDir(id), 'doc.html'))) {
    meta.id = id;
    const docTitle = meta.title || `Document ${id}`;
    return res.send(SHELL(docTitle, viewBody(meta), { bodyClass: 'viewer' }));
  }

  if (req.query.retry) pending.delete(id);
  const state = pending.get(id);
  if (state?.error) {
    return res.send(SHELL('Something went wrong', errorBody(id, state.error.message), { bodyClass: 'viewer' }));
  }
  if (!state) kickOff(id, `https://www.scribd.com/document/${id}/`);
  res.send(SHELL('Opening document…', loadingBody(id), { bodyClass: 'viewer' }));
});

app.get('/status/:id', (req, res) => {
  const id = req.params.id;
  if (readMeta(id)) return res.json({ status: 'ready' });
  const state = pending.get(id);
  if (state?.error) return res.json({ status: 'error', message: state.error.message });
  if (state) return res.json({ status: 'pending' });
  return res.json({ status: 'unknown' });
});

// A rendered copy never changes once written (it is keyed by doc id and
// written once), so the visiting browser is told to cache it indefinitely.
// A repeat view of the same document is then served entirely from the
// browser's own cache - the server, and this machine's browser instance, are
// not touched again for it.
app.get('/raw/:id', (req, res) => {
  const f = path.join(docDir(req.params.id), 'doc.html');
  if (!fs.existsSync(f)) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.type('html').send(fs.readFileSync(f, 'utf-8'));
});

app.get('/pdf/:id', async (req, res) => {
  const id = req.params.id;
  const d = docDir(id);
  const htmlFile = path.join(d, 'doc.html');
  const pdfFile = path.join(d, 'doc.pdf');
  if (!fs.existsSync(htmlFile)) return res.redirect(`/view/${id}`);
  if (!fs.existsSync(pdfFile)) {
    await withRenderLock(async () => {
      if (!fs.existsSync(pdfFile)) await renderPdf(htmlFile, pdfFile);
    });
  }
  const meta = readMeta(id) || {};
  const name = safeName(meta.title || `scribd-${id}`) + '.pdf';
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.download(pdfFile, name);
});

// ---------------------------------------------------------------------------
// Cache cleanup, meant to be hit by an external cron rather than run in-process
// (a setInterval here would restart its clock every time the server restarts,
// and would have nothing to run against between deploys).
// ---------------------------------------------------------------------------

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

function cleanupCache(maxAgeHours) {
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  const removed = [];
  let freedBytes = 0;
  for (const entry of fs.readdirSync(CACHE, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(CACHE, entry.name);
    const marker = path.join(dir, 'meta.json');
    let mtime;
    try {
      mtime = fs.statSync(fs.existsSync(marker) ? marker : dir).mtimeMs;
    } catch {
      continue; // vanished between readdir and stat, nothing to do
    }
    if (mtime >= cutoff) continue;
    freedBytes += dirSize(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return { removed, freedBytes };
}

// POST only, so a stray GET (a crawler, a browser prefetch) can't trigger it.
// Set CLEANUP_TOKEN to require a matching ?token= or X-Cleanup-Token header -
// worth doing if this ever runs anywhere reachable beyond your own cron.
app.post('/admin/cleanup', (req, res) => {
  const required = process.env.CLEANUP_TOKEN;
  if (required && req.get('x-cleanup-token') !== required && req.query.token !== required) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const raw = req.query.maxAgeHours;
  const maxAgeHours = raw === undefined || raw === '' ? DEFAULT_CLEANUP_MAX_AGE_HOURS : Number(raw);
  if (!Number.isFinite(maxAgeHours) || maxAgeHours < 0) {
    return res.status(400).json({ error: 'maxAgeHours must be a non-negative number' });
  }
  const { removed, freedBytes } = cleanupCache(maxAgeHours);
  res.json({ ok: true, maxAgeHours, removedCount: removed.length, removed, freedBytes });
});

const port = Number(process.env.PORT || 5000);
app.listen(port, '127.0.0.1', () => {
  console.log(`open http://127.0.0.1:${port}   (headless=${HEADLESS})`);
});
