/**
 * The capture engine.
 *
 * Renders a publicly viewable Scribd document with a real browser and returns a
 * self-contained copy of it, in the document's own styling, plus metadata about
 * what was and was not available.
 *
 * Scope, on purpose: it does not sign in, does not forge challenge tokens, and
 * does not unlock paywalled pages. Withheld pages are reported, not fetched.
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium, resolveBrowser, launchHeadless, SERVER_ARGS } from './browser.js';
import * as inject from './inject.js';

export const PROFILE_DIR = path.resolve(process.env.PROFILE_DIR || '.profile');
const DOC_URL = (id) => `https://www.scribd.com/document/${id}/`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const cssUrlRe = () => /url\(\s*['"]?(?!data:)([^'")]+?)['"]?\s*\)/g;

export function resolveUrl(target) {
  const t = String(target || '').trim();
  if (/^\d+$/.test(t)) return DOC_URL(t);
  const withScheme = /^https?:\/\//.test(t) ? t : 'https://' + t;
  if (!withScheme.includes('scribd.com')) {
    throw new Error(`Not a scribd.com URL: ${target}`);
  }
  return withScheme;
}

export function safeName(text, fallback = 'scribd-document') {
  const cleaned = String(text || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return cleaned.slice(0, 120) || fallback;
}

const esc = (v) =>
  String(v)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** Drop whole at-rule blocks whose header matches, honouring nesting. */
function stripBlocks(css, headRe) {
  let out = '';
  let i = 0;
  for (;;) {
    headRe.lastIndex = i;
    const m = headRe.exec(css);
    if (!m) return out + css.slice(i);
    out += css.slice(i, m.index);
    let depth = 1;
    let j = headRe.lastIndex;
    while (j < css.length && depth) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    i = j;
  }
}

/**
 * Download one asset as a data URI, retrying transient failures.
 *
 * Without this a single hiccup - a timeout, a 5xx, a reset connection -
 * permanently drops an asset, which showed up as an intermittent "1 asset
 * failed" that moved between documents from run to run. A hard 4xx is not
 * retried, since it will not improve.
 */
async function dataUri(request, url, attempts = 3) {
  let last = 'failed';
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const resp = await request.get(url, { timeout: 45_000 });
      if (resp.ok()) {
        const body = await resp.body();
        const ctype =
          (resp.headers()['content-type'] || 'application/octet-stream')
            .split(';')[0]
            .trim() || 'application/octet-stream';
        return `data:${ctype};base64,` + body.toString('base64');
      }
      last = `HTTP ${resp.status()}`;
      if (resp.status() >= 400 && resp.status() < 500 && resp.status() !== 429) break;
    } catch (err) {
      last = `${err.name}: ${err.message}`;
    }
    if (attempt + 1 < attempts) {
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw new Error(last);
}

// ---------------------------------------------------------------------------
// Page loading
// ---------------------------------------------------------------------------

/**
 * Bring every page into view in order and wait for each one to render.
 *
 * Blind wheel-scrolling is not enough. A scanned document's page image is
 * fetched only when that page is genuinely brought into view, so sweeping past
 * in big jumps leaves most pages empty - and because a src-less <img> reports
 * complete === true, a naive loop believes they are done.
 */
async function loadAllPages(page, timeoutS, quiet) {
  const deadline = Date.now() + timeoutS * 1000;
  let stats = await page.evaluate(inject.pageStats);
  let total = stats.total;
  let n = 1;

  while (n <= total && Date.now() < deadline) {
    const el = await page.$(`#outer_page_${n}`);
    if (el) {
      await el.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      const budget = Math.max(0, Math.min(8_000, deadline - Date.now()));
      if (budget > 500) {
        await page
          .waitForFunction(inject.readyOne, n, { timeout: budget })
          .catch(() => {}); // withheld, or genuinely never loads - reported later
      }
    }
    stats = await page.evaluate(inject.pageStats);
    total = Math.max(total, stats.total); // Scribd can append pages as you go
    if (!quiet) process.stderr.write(`  rendered ${stats.ready}/${total} pages\r`);
    n++;
  }

  const walkedAll = n > total;

  // Second pass over stragglers. A page whose image was still in flight when
  // the walk went past it gets captured with that image dropped - and because a
  // slow image is a matter of timing, that becomes an intermittent failure.
  for (let round = 0; round < 3; round++) {
    stats = await page.evaluate(inject.pageStats);
    const pending = stats.pages.filter((p) => !p.ready).map((p) => p.n);
    if (!pending.length || Date.now() >= deadline) break;
    if (!quiet) process.stderr.write(`  retrying ${pending.length} unfinished page(s)   \r`);
    for (const pn of pending) {
      if (Date.now() >= deadline) break;
      const el = await page.$(`#outer_page_${pn}`);
      if (!el) continue;
      await el.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
      const budget = Math.max(0, Math.min(6_000, deadline - Date.now()));
      if (budget > 500) {
        await page.waitForFunction(inject.readyOne, pn, { timeout: budget }).catch(() => {});
      }
    }
  }

  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, 0));
  const result = await page.evaluate(inject.pageStats);

  // Only blame the clock when the clock is actually to blame: a page still
  // unfinished with time left over is withheld, not slow.
  const stillPending = result.pages.filter((p) => !p.ready).map((p) => p.n);
  result.timedOut = stillPending.length > 0 && (Date.now() >= deadline || !walkedAll);
  result.reached = n - 1;
  return result;
}

// ---------------------------------------------------------------------------
// Offline copy assembly
// ---------------------------------------------------------------------------

/**
 * Assemble a self-contained copy, inlining CSS, fonts and images.
 *
 * Getting a page to *look* right takes more than copying markup and CSS, for
 * four reasons found by measuring against the live page:
 *
 *  1. The document's fonts come from the JS FontFace API, so CSS harvesting
 *     cannot see them. Handled by the init-script hook; shipped here.
 *  2. Page rules use descendant selectors on hashed wrapper classes, so the
 *     ancestor chain is rebuilt as empty wrappers.
 *  3. Those rules resolve through --spl-* tokens declared in no stylesheet, so
 *     they are resolved off the live root and emitted here.
 *  4. Scribd's own @page and @media print rules must go: one of them sets
 *     opacity 0 on a wrapper we rebuild, which blanks the entire PDF.
 */
export async function buildOfflineHtml(context, cap, title, quiet, fonts = []) {
  const request = context.request;
  const base = cap.base;

  let css = cap.inlineCss;
  for (const url of cap.sheetUrls) {
    try {
      const resp = await request.get(url, { timeout: 45_000 });
      if (resp.ok()) css += '\n' + (await resp.text());
    } catch {
      /* unreachable sheet, skip */
    }
  }

  // Everything the copy needs: webfonts referenced from CSS, plus page images.
  const wanted = new Set();
  for (const m of css.matchAll(cssUrlRe())) {
    const raw = m[1];
    // Scribd ships unfilled template placeholders such as "<path-to-image>";
    // they resolve to 403s and are not document content.
    if (raw.includes('<') || raw.includes('>') || raw.includes('path-to-')) continue;
    try {
      const absUrl = new URL(raw, base).href;
      if (/^https?:\/\//.test(absUrl)) wanted.add(absUrl);
    } catch {
      /* unparseable url() */
    }
  }
  for (const u of cap.images) if (/^https?:\/\//.test(u)) wanted.add(u);
  for (const face of fonts) {
    for (const m of String(face.cssSrc || '').matchAll(cssUrlRe())) {
      try {
        const absUrl = new URL(m[1], base).href;
        if (/^https?:\/\//.test(absUrl)) wanted.add(absUrl);
      } catch {
        /* skip */
      }
    }
  }

  const inlined = new Map();
  const failed = [];
  const wantedList = [...wanted].sort();
  const concurrency = Number(process.env.CONCURRENT_DOWNLOADS) || 4;
  let cursor = 0;
  let finished = 0;

  const workers = Array.from({ length: Math.min(concurrency, wantedList.length) }, async () => {
    while (cursor < wantedList.length) {
      const idx = cursor++;
      const url = wantedList[idx];
      try {
        const uri = await dataUri(request, url);
        inlined.set(url, uri);
      } catch (err) {
        failed.push(`${url} (${err.message})`);
      }
      finished++;
      if (!quiet) process.stderr.write(`  inlined ${finished}/${wantedList.length} assets\r`);
    }
  });
  await Promise.all(workers);

  // Fast single-pass regex replacement instead of repeated split/join passes
  const swapMap = new Map();
  const patterns = [];
  for (const [url, data] of inlined) {
    const escaped = url.replace(/&/g, '&amp;');
    swapMap.set(url, data);
    patterns.push(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (escaped !== url) {
      swapMap.set(escaped, data);
      patterns.push(escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
  }
  const swapRe = patterns.length ? new RegExp(patterns.join('|'), 'g') : null;
  const swap = (text) => (swapRe ? text.replace(swapRe, (m) => swapMap.get(m) || m) : text);

  css = swap(css);
  css = css.replace(/@page[^{]*\{[^{}]*\}/g, '');
  css = stripBlocks(css, /@media[^{]*\bprint\b[^{]*\{/g);

  // Join with no whitespace: a stray text node between page boxes creates an
  // anonymous line box that spills into an extra, blank sheet.
  const body = cap.blocks.map(swap).join('');

  // Real fonts the page registered in JavaScript. Without these the text layer
  // falls back down its stack and every glyph width changes.
  const faceRules = [];
  for (const face of fonts) {
    const family = String(face.family || '').trim();
    if (!family) continue;
    let src;
    if (face.dataUri) {
      src = `url("${face.dataUri}")` + (face.format ? ` format("${face.format}")` : '');
    } else if (face.cssSrc) {
      const absolute = String(face.cssSrc).replace(cssUrlRe(), (_m, raw) => {
        try {
          return `url("${new URL(raw, base).href}")`;
        } catch {
          return _m;
        }
      });
      src = swap(absolute);
      if (!src.includes('data:')) continue; // a remote src is useless offline
    } else {
      continue;
    }
    const decl = [`font-family:'${family}'`, `src:${src}`];
    for (const [prop, key] of [
      ['font-weight', 'weight'],
      ['font-style', 'style'],
      ['font-stretch', 'stretch'],
      ['unicode-range', 'unicodeRange'],
    ]) {
      if (face[key]) decl.push(`${prop}:${face[key]}`);
    }
    faceRules.push('@font-face{' + decl.join(';') + '}');
  }
  const fontCss = faceRules.join('');

  // Design tokens the captured rules depend on, resolved off the live page.
  const decls = Object.entries(cap.vars || {})
    .filter(([, v]) => !String(v).includes('<') && !String(v).includes('}'))
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
  const tokenCss = decls ? `:root{${decls}}` : '';

  // Page geometry. When every sheet is the same size a single @page box is
  // enough and the explicit break drives pagination. When sizes differ each
  // sheet needs its own named @page - and then the named page change is itself
  // the break, so an explicit break-after would emit a blank sheet between
  // every page.
  const sizes = cap.sizes;
  const uniform = new Set(sizes.map((s) => s.join('x'))).size <= 1;
  let pageBoxes;
  let named = '';
  let breakRules;
  if (uniform) {
    const [w, h] = sizes[0];
    pageBoxes = `@page{size:${w}px ${h}px;margin:0}`;
  } else {
    pageBoxes = sizes.map(([w, h], k) => `@page sdlp${k + 1}{size:${w}px ${h}px;margin:0}`).join('\n');
    named = sizes.map((_s, k) => `.outer_page:nth-of-type(${k + 1}){page:sdlp${k + 1}}`).join('\n');
  }
  void breakRules;

  // Rebuild Scribd's ancestor chain as empty wrappers. Those wrappers carry
  // geometry meant for the scaled-down viewer (the container is ~631 px wide,
  // our un-scaled pages are 902 px), so an sdl-anc marker neutralises their box
  // while leaving their paint - background, border, tokens - completely alone.
  const opens = [];
  const closes = [];
  for (const anc of cap.chain || []) {
    const tag = ['div', 'main', 'section', 'article'].includes(anc.tag) ? anc.tag : 'div';
    let attrs = ` class="${esc((anc.cls + ' sdl-anc').trim())}"`;
    if (anc.id) attrs += ` id="${esc(anc.id)}"`;
    opens.push(`<${tag}${attrs}>`);
    closes.push(`</${tag}>`);
  }
  const chainOpen = opens.join('');
  const chainClose = closes.reverse().join('');

  const ancCss =
    '.sdl-anc{width:auto!important;min-width:0!important;max-width:none!important;' +
    'height:auto!important;min-height:0!important;max-height:none!important;' +
    'overflow:visible!important;transform:none!important;position:static!important;' +
    'margin:0!important;padding:0!important;display:block!important;float:none!important}';

  // On screen, supply only what a bare page fragment cannot supply itself: the
  // backdrop Scribd's app shell paints (#fcfcfc) and a centred stage. The page
  // boxes are left alone - their background, border and spacing come from
  // Scribd's own .outer_page rules, which the capture already carries.
  const screenCss =
    '@media screen{' +
    'html,body{margin:0;padding:0;background:#fcfcfc}' +
    '.sdl-stage{width:-moz-fit-content;width:fit-content;margin:0 auto;padding:8px 0}' +
    '.outer_page{position:relative;overflow:hidden;content-visibility:auto;contain-intrinsic-size:900px 1200px}' +
    '}';

  const printCss =
    '@media print{' +
    pageBoxes +
    'html,body{margin:0!important;padding:0!important;background:#fff}' +
    '.sdl-stage{width:auto!important;margin:0!important;padding:0!important}' +
    '.outer_page{margin:0!important;padding:0!important;border:0!important;' +
    'box-shadow:none!important;position:relative;overflow:hidden;' +
    'content-visibility:visible!important;' +
    'break-after:page;page-break-after:always}' +
    '.outer_page:last-child{break-after:auto;page-break-after:auto}' +
    named +
    '}';

  const rootAttrs = (cls, data) => {
    let out = cls ? ` class="${esc(cls)}"` : '';
    for (const [k, v] of Object.entries(data || {})) out += ` ${esc(k)}="${esc(v)}"`;
    return out;
  };
  const htmlOpen = `<html lang="${esc(cap.lang || 'en')}"${rootAttrs(cap.htmlClass, cap.htmlData)}>`;
  const bodyOpen = `<body${rootAttrs(cap.bodyClass, cap.bodyData)}>`;
  const safeTitle = String(title).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  const html =
    '<!doctype html>\n' +
    htmlOpen +
    '<head><meta charset="utf-8">\n' +
    `<title>${safeTitle}</title>\n` +
    // Real fonts, then tokens, then document CSS, then our geometry last.
    `<style>${fontCss}</style>\n` +
    `<style>${tokenCss}</style>\n` +
    `<style>${css}</style>\n` +
    `<style>${ancCss}${screenCss}${printCss}</style>\n` +
    '</head>' +
    bodyOpen +
    `<div class="sdl-stage">${chainOpen}${body}${chainClose}</div>` +
    '</body></html>';

  return { html, failed };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Render a document once and return { html, meta }. */
const DEFAULT_TIMEOUT = Number(process.env.CAPTURE_TIMEOUT_SECONDS) || 120;

export async function captureDocument(
  target,
  { headless = true, timeout = DEFAULT_TIMEOUT, quiet = true } = {}
) {
  const url = resolveUrl(target);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1400, height: 1000 },
    args: [
      ...SERVER_ARGS,
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
    ],
    ...(await resolveBrowser()),
  });

  try {
    // Must be installed before any page script runs.
    await context.addInitScript(inject.fontHook);
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    try {
      await page.waitForSelector('#outer_page_1', { timeout: timeout * 1000 });
    } catch {
      const t = await page.title();
      if (/challenge/i.test(t)) {
        throw new Error(
          'Scribd served its bot challenge and it never cleared. Start with ' +
            'HEADLESS=0 so a real window can load the page once; the profile is then reused.'
        );
      }
      throw new Error(`No document pages found (page title: ${JSON.stringify(t)}).`);
    }

    const stats = await loadAllPages(page, timeout, quiet);
    if (!stats.ready) throw new Error('Nothing rendered - no publicly viewable pages.');

    const cap = await page.evaluate(inject.capture);
    if (!cap.blocks.length) throw new Error('Capture produced no pages.');

    const title = stats.title || 'scribd-document';
    const fonts = await page.evaluate(inject.fontDump);
    const { html, failed } = await buildOfflineHtml(context, cap, title, quiet, fonts);

    const notReady = stats.pages.filter((p) => !p.ready).map((p) => p.n);
    const timedOut = Boolean(stats.timedOut);

    const meta = {
      title,
      url,
      pages: cap.blocks.length,
      total: stats.total,
      // Only call a page locked when the walk actually got to it.
      locked: timedOut ? [] : notReady,
      unreached: timedOut ? notReady : [],
      timedOut,
      assetsFailed: failed,
      sizes: cap.sizes,
      fonts: [...new Set(fonts.map((f) => f.family).filter(Boolean))].sort(),
      // Pages whose only content is an image that never loaded. These are the
      // ones that used to come out as silently blank sheets.
      blank: cap.blank || [],
      imagesDropped: cap.droppedImgs || 0,
      kind: stats.pages.some((p) => p.text)
        ? 'text'
        : stats.pages.some((p) => p.imgs)
          ? 'scanned'
          : 'unknown',
    };
    return { html, meta };
  } finally {
    await context.close();
  }
}

/** Print a captured copy to PDF. Local file, no network, vector text. */
export async function renderPdf(htmlPath, pdfPath) {
  const browser = await launchHeadless();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.resolve(htmlPath)).href, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    await page.waitForTimeout(200); // brief settling time
    await page.pdf({ path: pdfPath, printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}
