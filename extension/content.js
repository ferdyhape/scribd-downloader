/**
 * Scribd Downloader Extension - Content Script (High-Fidelity Engine)
 * Replicates the exact capture flow of lib/capture.js and lib/inject.js directly in the browser.
 */

(function () {
  if (window.__scribdReaderHighFidelityLoaded) return;
  window.__scribdReaderHighFidelityLoaded = true;

  // Shared across every page (and every font) in one export run: the same
  // URL can show up more than once, so fetch it through the background
  // worker only once.
  const dataUriCache = new Map();

  /**
   * Fetches one URL's real bytes as a data URI via the background worker -
   * used for both page images and, below, url()-sourced fonts - so the
   * export is genuinely self-contained instead of quietly depending on a
   * live, signed, expiring scribdassets.com URL. Returns null (falls back to
   * the live URL at the image call site) if the fetch ultimately fails.
   */
  function fetchDataUri(src) {
    if (!dataUriCache.has(src)) {
      const promise = new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'FETCH_AS_DATA_URI', url: src }, (res) => {
          if (chrome.runtime.lastError || !res || !res.dataUri) {
            resolve(null);
            return;
          }
          resolve(res.dataUri);
        });
      });
      dataUriCache.set(src, promise);
    }
    return dataUriCache.get(src);
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'GET_PAGE_INFO') {
      sendResponse(getPageInfo());
      return false;
    }

    if (request.action === 'CLEAN_VIEW') {
      const result = cleanLiveTab();
      sendResponse(result);
      return false;
    }

    if (request.action === 'EXPORT_OFFLINE_HTML') {
      generateHighFidelityDocument((progress) => {
        chrome.runtime.sendMessage({ action: 'EXPORT_PROGRESS', progress }).catch(() => {});
      }).then((result) => {
        openOfflineTab(result.html, getCleanTitle());
        sendResponse({ success: true, ...pageSummary(result) });
      }).catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
      return true; // async
    }
  });

  /** Basic page info for popup */
  function getPageInfo() {
    const outers = document.querySelectorAll('[id^="outer_page_"]');
    const title = getCleanTitle();
    return {
      isScribd: window.location.hostname.includes('scribd.com'),
      isDocPage: window.location.pathname.includes('/document/') || window.location.pathname.includes('/doc/'),
      pageCount: outers.length,
      title: title,
    };
  }

  function getCleanTitle() {
    const titleEl = document.querySelector('h1, .document_title, [data-testid="doc-title"]');
    let t = titleEl ? titleEl.textContent.trim() : document.title;
    return (t || 'Scribd Document').replace(/\s*\|\s*PDF\s*$/i, '').trim();
  }

  /** Reduces a generateHighFidelityDocument() result to what the popup needs. */
  function pageSummary(result) {
    const missing = (result.blankPages || []).length + (result.skippedPages || []).length;
    return { totalPages: result.totalPages, capturedPages: result.capturedPages, missingPages: missing };
  }

  /**
   * Asks font-hook.js (running in the page's MAIN world, see that file for
   * why) for the fonts it captured before Scribd's own script ran. The two
   * scripts do not share a JS global object - only the DOM - so this is a
   * DOM CustomEvent round trip rather than a direct read. Resolves to []
   * if nothing answers within the timeout (e.g. the hook never installed).
   */
  function requestCapturedFonts() {
    return new Promise((resolve) => {
      let done = false;
      const onResponse = (e) => {
        if (done) return;
        done = true;
        window.removeEventListener('__sdlDumpFontsResponse', onResponse);
        resolve(e.detail || []);
      };
      window.addEventListener('__sdlDumpFontsResponse', onResponse);
      window.dispatchEvent(new CustomEvent('__sdlDumpFontsRequest'));
      setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener('__sdlDumpFontsResponse', onResponse);
        resolve([]);
      }, 500);
    });
  }

  /**
   * Serialises the fonts requestCapturedFonts() returns: binary sources
   * become data URIs directly; url()-sourced ones are resolved by the
   * caller through fetchDataUri(). Matches lib/inject.js's fontDump().
   */
  async function dumpCapturedFonts() {
    const rawFonts = await requestCapturedFonts();
    const sniff = (b) => {
      const tag = String.fromCharCode(b[0], b[1], b[2], b[3]);
      if (tag === 'wOF2') return ['font/woff2', 'woff2'];
      if (tag === 'wOFF') return ['font/woff', 'woff'];
      if (tag === 'OTTO') return ['font/otf', 'opentype'];
      return ['font/ttf', 'truetype'];
    };
    const b64 = (bytes) => {
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    };
    const out = [];
    const seen = new Set();
    for (const rec of rawFonts || []) {
      const fam = String(rec.family || '').replace(/["']/g, '').trim();
      if (!fam) continue;
      const d = rec.descriptors || {};
      const key = `${fam}|${d.weight || ''}|${d.style || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const meta = {
        family: fam,
        weight: d.weight || '',
        style: d.style || '',
        stretch: d.stretch || '',
        unicodeRange: d.unicodeRange || '',
      };
      if (typeof rec.source === 'string') {
        meta.cssSrc = rec.source; // a url()-based FontFace - resolved by the caller
        out.push(meta);
        continue;
      }
      try {
        const buf = rec.source && rec.source.buffer ? rec.source.buffer : rec.source;
        if (!buf || !buf.byteLength) continue;
        const bytes = new Uint8Array(buf);
        const sn = sniff(bytes);
        meta.dataUri = `data:${sn[0]};base64,${b64(bytes)}`;
        out.push(meta);
      } catch (e) {
        /* skip a face we cannot read */
      }
    }
    return out;
  }

  /**
   * Drops whole at-rule blocks whose header matches, honouring nested braces
   * (an @media block's body can itself contain further { } pairs, so a plain
   * "match to the next }" regex would cut it short). Matches lib/capture.js's
   * stripBlocks() exactly.
   */
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

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** Toast notification banner */
  function showToast(message, type = 'info', duration = 3500) {
    const existing = document.getElementById('__scribd_reader_toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = '__scribd_reader_toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 99999999;
      background: ${type === 'error' ? '#991b1b' : type === 'success' ? '#166534' : '#1e293b'};
      color: #fff;
      padding: 12px 20px;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      font-weight: 500;
      box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3);
      display: flex;
      align-items: center;
      gap: 10px;
      transition: opacity 0.3s, transform 0.3s;
    `;

    toast.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        ${type === 'success'
          ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>'
          : '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>'}
      </svg>
      <span>${message}</span>
    `;

    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  /** Quick Clean mode for live tab */
  function cleanLiveTab() {
    const blockers = [
      '.between_page_module',
      '.between_page_portal_root',
      '.promo_banner',
      '.page_missing_explanation',
      '.autogen_class_views_read_document_wrapper_banner',
      '.sticky_anchor_bottom',
      '[class*="paywall"]',
      '[class*="upsell"]',
      '[class*="ad_wrapper"]',
    ];

    blockers.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => (el.style.display = 'none'));
    });

    document.querySelectorAll('[class*="blur"], .blurred_page').forEach((el) => {
      el.classList.remove('blurred_page', 'blur');
      el.style.filter = 'none';
      el.style.opacity = '1';
    });

    let style = document.getElementById('__scribd_reader_quick_style');
    if (!style) {
      style = document.createElement('style');
      style.id = '__scribd_reader_quick_style';
      style.textContent = `
        .outer_page, .page, .text_layer, .text_layer span, .image_layer {
          filter: none !important;
          opacity: 1 !important;
          visibility: visible !important;
        }
        body, .document_column, .outer_page, .text_layer, .text_layer span {
          user-select: text !important;
          -webkit-user-select: text !important;
        }
      `;
      document.head.appendChild(style);
    }

    showToast('Clean Reader active! Overlays hidden & text unlocked.', 'success');
    return { success: true };
  }

  /**
   * Helper: checks if a single page has decoded images and rendered content.
   * Matches lib/inject.js readyOne(n).
   */
  function isPageReady(n) {
    const inner = document.getElementById('page' + n);
    if (!inner) return false;
    const imgs = [...inner.querySelectorAll('img')];
    if (!imgs.every((i) => i.naturalWidth > 0)) return false;
    const layer = inner.querySelector('.text_layer');
    const hasText = !!layer && layer.textContent.trim().length > 0;
    const canvases = [...inner.querySelectorAll('canvas')];
    return hasText || imgs.length > 0 || canvases.length > 0;
  }

  // Overall budget for a full walk. Generous but bounded, so a document that
  // genuinely never finishes doesn't hang the popup forever.
  const WALK_TIMEOUT_MS = 100_000;

  /**
   * Lazy-loading page walker: a per-page adaptive wait, then up to three
   * retry rounds over whatever is still not ready. Matches lib/capture.js
   * loadAllPages() - a flat 1.5s-then-400ms budget (what this used to be)
   * gives noticeably thinner margin than that, and on a slow connection or a
   * large scanned document that is exactly the gap that caused intermittent
   * dropped images in the server engine before its retry pass was added.
   */
  async function walkAllPages(outers, progressCallback, overallTimeoutMs = WALK_TIMEOUT_MS) {
    const originalScrollY = window.scrollY;
    const deadline = Date.now() + overallTimeoutMs;
    let index = 0;

    for (const outer of outers) {
      index++;
      const n = +outer.id.split('_').pop();
      if (progressCallback) progressCallback({ current: index, total: outers.length });

      outer.scrollIntoView({ behavior: 'auto', block: 'center' });
      const budget = Math.min(8000, Math.max(0, deadline - Date.now()));
      const start = Date.now();
      while (Date.now() - start < budget && !isPageReady(n)) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    // A page whose image was still in flight when the first pass went past
    // it would otherwise get captured half-loaded. Give it real chances to
    // catch up rather than one short second look.
    for (let round = 0; round < 3 && Date.now() < deadline; round++) {
      const pending = outers.filter((outer) => !isPageReady(+outer.id.split('_').pop()));
      if (!pending.length) break;
      for (const outer of pending) {
        if (Date.now() >= deadline) break;
        const n = +outer.id.split('_').pop();
        outer.scrollIntoView({ behavior: 'auto', block: 'center' });
        const budget = Math.min(6000, Math.max(0, deadline - Date.now()));
        const start = Date.now();
        while (Date.now() - start < budget && !isPageReady(n)) {
          await new Promise((r) => setTimeout(r, 150));
        }
      }
    }

    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready.catch(() => {});
    }

    window.scrollTo({ top: originalScrollY, behavior: 'auto' });
  }

  /**
   * Generates the complete, self-contained, high-fidelity offline HTML document.
   * Matches the architecture of lib/inject.js capture() + lib/capture.js buildOfflineHtml(),
   * including skipping pages with no real content instead of emitting them blank.
   *
   * Resolves to { html, totalPages, capturedPages, blankPages, skippedPages }.
   */
  async function generateHighFidelityDocument(progressCallback) {
    const outers = [...document.querySelectorAll('[id^="outer_page_"]')].sort(
      (a, b) => +a.id.split('_').pop() - +b.id.split('_').pop()
    );

    if (!outers.length) {
      throw new Error('No Scribd document pages found on this tab.');
    }

    showToast(`Scanning & rendering ${outers.length} pages…`, 'info', 5000);

    // 1. Walk all pages to ensure every image and canvas is triggered
    await walkAllPages(outers, progressCallback);

    // 2. Harvest CSSOM rules (matches lib/inject.js lines 198-210)
    const cssParts = [];
    for (const s of document.querySelectorAll('style')) {
      let text = '';
      try {
        if (s.sheet && s.sheet.cssRules && s.sheet.cssRules.length) {
          text = [...s.sheet.cssRules].map((r) => r.cssText).join('\n');
        }
      } catch (e) {
        /* unreadable sheet */
      }
      cssParts.push(text || s.textContent || '');
    }
    // Scribd's own @page rules fight the fixed per-page sizes built below.
    // Its @media print rules are worse: they exist to hide Scribd's own app
    // shell when someone prints the live site, and one of them targets a
    // hashed wrapper class - the same kind of class the ancestor-chain
    // rebuild below recreates on purpose, for the descendant selectors that
    // paint the page's background and border. The rule's effect is to blank
    // the whole thing out under @media print. Screen rendering was never
    // affected by either, which is exactly why this was invisible until an
    // actual PDF was checked, not just the on-screen reader.
    let inlineCss = cssParts.join('\n');
    inlineCss = inlineCss.replace(/@page[^{]*\{[^{}]*\}/g, '');
    inlineCss = stripBlocks(inlineCss, /@media[^{]*\bprint\b[^{]*\{/g);

    // 3. Harvest external stylesheets (matches lib/inject.js lines 212-214)
    const sheetUrls = [...document.querySelectorAll('link[rel="stylesheet"]')]
      .map((l) => l.href)
      .filter((h) => /scribdassets\.com/.test(h));

    // 4. Resolve --spl-* design tokens (matches lib/inject.js lines 222-231)
    const rootCS = getComputedStyle(document.documentElement);
    const vars = {};
    const varRe = /var\(\s*(--[A-Za-z0-9_-]+)/g;
    let vm;
    while ((vm = varRe.exec(inlineCss)) !== null) {
      const name = vm[1];
      if (name in vars) continue;
      const val = rootCS.getPropertyValue(name).trim();
      if (val) vars[name] = val;
    }
    const tokenCss = `:root{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';')}}`;

    // 4.5. Rebuild @font-face rules for the document's real fonts, captured
    // by font-hook.js before Scribd's own script could register them.
    // Without these the text layer falls back down its font stack and every
    // glyph width changes - confirmed directly: a fresh document.write()'d
    // iframe (exactly what this export opens) starts with document.fonts.size
    // === 0, none of the opener's fonts carry over, custom or not.
    const capturedFonts = await dumpCapturedFonts();
    const faceRules = [];
    for (const face of capturedFonts) {
      let src = null;
      if (face.dataUri) {
        src = `url("${face.dataUri}")`;
      } else if (face.cssSrc) {
        const urlMatch = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(face.cssSrc);
        if (urlMatch) {
          let absUrl = null;
          try {
            absUrl = new URL(urlMatch[1], location.href).href;
          } catch (e) {
            /* unparseable url() - skip this face */
          }
          if (absUrl) {
            const fetched = await fetchDataUri(absUrl);
            if (fetched) src = `url("${fetched}")`;
          }
        }
      }
      if (!src) continue; // could not resolve - skip rather than reference a URL that may vanish
      const decl = [`font-family:'${face.family}'`, `src:${src}`];
      if (face.weight) decl.push(`font-weight:${face.weight}`);
      if (face.style) decl.push(`font-style:${face.style}`);
      if (face.stretch) decl.push(`font-stretch:${face.stretch}`);
      if (face.unicodeRange) decl.push(`unicode-range:${face.unicodeRange}`);
      faceRules.push(`@font-face{${decl.join(';')}}`);
    }
    const fontCss = faceRules.join('');

    // 5. Clone and freeze pages (matches lib/inject.js lines 244-363)
    const blocks = [];
    const sizes = [];
    // Pages Scribd never rendered into the DOM at all, and pages whose only
    // possible content was an image that never loaded (a locked/restricted
    // page shows up exactly this way - present as a container, empty inside).
    // Emitting either as a page would silently produce a blank sheet in the
    // PDF; the server engine hit this exact bug and now skips both instead.
    const skipped = [];
    const blank = [];

    for (const outer of outers) {
      const n = +outer.id.split('_').pop();
      const inner = document.getElementById('page' + n);
      if (!inner) {
        skipped.push(n);
        continue;
      }

      const readinessLayer = inner.querySelector('.text_layer');
      const hasText = !!readinessLayer && readinessLayer.textContent.trim().length > 0;
      const rawImgs = [...inner.querySelectorAll('img')];
      const rawLoadedImgs = rawImgs.filter((i) => i.naturalWidth > 0);
      const rawCanvases = [...inner.querySelectorAll('canvas')];
      const hasCanvasContent = rawCanvases.some((c) => c.width > 0 && c.height > 0);

      if (!hasText && rawImgs.length === 0 && rawCanvases.length === 0) {
        skipped.push(n); // nothing here at all, not even an unloaded placeholder
        continue;
      }
      if (!hasText && rawLoadedImgs.length === 0 && !hasCanvasContent) {
        blank.push(n); // the only possible content was an image, and it never loaded
        continue;
      }

      const sm = /width:\s*([\d.]+)px;\s*height:\s*([\d.]+)px/.exec(
        inner.getAttribute('style') || ''
      );
      const w = sm ? Math.round(+sm[1]) : Math.round(outer.getBoundingClientRect().width);
      const h = sm ? Math.round(+sm[2]) : Math.round(outer.getBoundingClientRect().height);
      sizes.push([w, h]);

      const clone = inner.cloneNode(true);
      clone.style.transform = 'none';
      clone.style.width = w + 'px';
      clone.style.height = h + 'px';
      clone.style.position = 'relative';
      clone.style.display = 'block';
      clone.querySelectorAll('script, iframe, noscript').forEach((e) => e.remove());

      // Convert any live <canvas> elements into <img> elements with exact data URLs
      const liveCanvases = [...inner.querySelectorAll('canvas')];
      const cloneCanvases = [...clone.querySelectorAll('canvas')];
      for (let i = 0; i < cloneCanvases.length; i++) {
        const lc = liveCanvases[i];
        if (lc && lc.width > 0 && lc.height > 0) {
          try {
            const cData = lc.toDataURL('image/png');
            const imgRep = document.createElement('img');
            imgRep.src = cData;
            imgRep.className = lc.className;
            imgRep.setAttribute('style', lc.getAttribute('style') || '');
            imgRep.width = lc.width;
            imgRep.height = lc.height;
            cloneCanvases[i].replaceWith(imgRep);
          } catch (e) {
            /* ignore unexportable canvas */
          }
        }
      }

      // Inline images as the real fetched bytes, via the background worker -
      // not a canvas re-encode, which silently fails (see background.js).
      const liveImgs = [...inner.querySelectorAll('img')];
      const cloneImgs = clone.querySelectorAll('img');
      for (let i = 0; i < cloneImgs.length; i++) {
        const live = liveImgs[i];
        if (!live || live.naturalWidth <= 0) continue;
        const src = live.currentSrc || live.src;
        if (!src) continue;
        const dataUri = await fetchDataUri(src);
        cloneImgs[i].setAttribute('src', dataUri || src);
      }

      const cls = (outer.className || '').toString().trim() || 'outer_page';
      blocks.push(
        `<div class="${cls}" id="outer_page_${n}" style="width:${w}px;height:${h}px">${clone.outerHTML}</div>`
      );
    }

    // 6. Ancestor wrapper chain (matches lib/capture.js lines 341-356)
    const opens = [];
    const closes = [];
    {
      const first = document.querySelector('[id^="outer_page_"]');
      let el = first ? first.parentElement : null;
      while (el && el !== document.body && el !== document.documentElement) {
        const tag = ['div', 'main', 'section', 'article'].includes(el.tagName.toLowerCase())
          ? el.tagName.toLowerCase()
          : 'div';
        const cls = (el.className || '').toString().trim();
        let attrs = ` class="${esc((cls + ' sdl-anc').trim())}"`;
        if (el.id) attrs += ` id="${esc(el.id)}"`;
        opens.push(`<${tag}${attrs}>`);
        closes.push(`</${tag}>`);
        el = el.parentElement;
      }
    }
    const chainOpen = opens.reverse().join('');
    const chainClose = closes.join('');

    const ancCss =
      '.sdl-anc{width:auto!important;min-width:0!important;max-width:none!important;' +
      'height:auto!important;min-height:0!important;max-height:none!important;' +
      'overflow:visible!important;transform:none!important;position:static!important;' +
      'margin:0!important;padding:0!important;display:block!important;float:none!important}';

    // 7. Exact per-page @page sizes (matches lib/capture.js lines 330-338)
    const pageBoxes = sizes
      .map(([w, h], k) => `@page sdlp${k + 1}{size:${w}px ${h}px;margin:0}`)
      .join('\n');
    const namedPages = sizes
      .map((_s, k) => `.outer_page:nth-of-type(${k + 1}){page:sdlp${k + 1}}`)
      .join('\n');

    // .outer_page gets NO cosmetic styling of our own here - no shadow, no
    // margin. Scribd's own harvested rule (background/border/margin, keyed
    // to a hashed wrapper class via the rebuilt sdl-anc ancestor chain) is
    // what paints it, exactly as lib/capture.js does server-side. Adding our
    // own box-shadow/margin here, as a previous version of this file did, is
    // precisely the kind of drift that makes a copy look like it was
    // reassembled rather than the source.
    const screenCss =
      '@media screen{' +
      'html,body{margin:0;padding:0;background:#fcfcfc}' +
      '.sdl-stage{width:-moz-fit-content;width:fit-content;margin:0 auto;padding:8px 0}' +
      '.outer_page{position:relative;overflow:hidden}' +
      '}';

    const printCss =
      '@media print{' +
      pageBoxes +
      'html,body{margin:0!important;padding:0!important;background:#fff}' +
      '.sdl-stage{width:auto!important;margin:0!important;padding:0!important}' +
      '.outer_page{margin:0!important;padding:0!important;border:0!important;' +
      'box-shadow:none!important;position:relative;overflow:hidden;' +
      'break-after:page;page-break-after:always}' +
      '.outer_page:last-child{break-after:auto;page-break-after:auto}' +
      namedPages +
      '}';

    const title = getCleanTitle();
    const linksHtml = sheetUrls.map((u) => `<link rel="stylesheet" href="${esc(u)}">`).join('\n');

    // Assemble complete HTML identical to server's doc.html
    const fullHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
${linksHtml}
<style>${fontCss}</style>
<style>${tokenCss}</style>
<style>${inlineCss}</style>
<style>${ancCss}${screenCss}${printCss}</style>
</head>
<body class="${esc(document.body.className || '')}">
<div class="sdl-stage">
${chainOpen}
${blocks.join('\n')}
${chainClose}
</div>
</body>
</html>`;

    if (!blocks.length) {
      throw new Error('None of the pages on this tab had any content to capture.');
    }

    const missing = blank.length + skipped.length;
    if (missing) {
      showToast(
        `${missing} of ${outers.length} page${outers.length === 1 ? '' : 's'} could not be captured ` +
          '(locked or still loading) and were left out rather than exported blank.',
        'info',
        6000
      );
    }

    return { html: fullHtml, totalPages: outers.length, capturedPages: blocks.length, blankPages: blank, skippedPages: skipped };
  }

  function safeFileName(text) {
    const cleaned = String(text || '')
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '');
    return cleaned.slice(0, 120) || 'scribd-document';
  }

  /**
   * A minimal reader shell around the captured document: a slim header with
   * real Download buttons, the document itself isolated in an iframe below
   * it (so our header's CSS can never collide with Scribd's, the same reason
   * the web app keeps its topbar outside the iframe rather than inside it).
   *
   * Two download actions, both real, both triggered from a button that sits
   * right on the document the user is already looking at - unlike the PDF
   * button this project used to have on the extension popup, which opened a
   * print dialog for a hidden iframe the user never saw and had no way to
   * connect back to anything on screen. That was the "fake" part; it was
   * never about print() itself.
   *   - Download HTML saves the exact file straight to disk.
   *   - Download PDF opens raw (unwrapped, no shell chrome) as its own real
   *     tab via window.open(), the same way this whole reader tab opens, and
   *     calls print() on that top-level window. Two attempts at printing
   *     through a nested off-screen iframe instead - contentWindow.print()
   *     on the visible reader iframe, then the same on a dedicated hidden
   *     one with explicit image-load waiting - both came out completely
   *     blank, identically, which pointed at print() through a nested frame
   *     being the wrong tool here rather than at any of the timing fixes
   *     tried along the way. A genuine top-level tab is what the rest of
   *     this file already knows renders correctly.
   *
   * The captured HTML is embedded as base64 inside a <script> - not written
   * into a srcdoc attribute or an f-string of raw markup - so nothing in the
   * document's own content (quotes, a stray "</script>"-looking substring)
   * can break out of its container. It's decoded and injected into the
   * iframe via document.write() once the shell itself has loaded.
   */
  function buildReaderShell(rawHtml, title) {
    const safeTitle = esc(title);
    const filename = safeFileName(title) + '.html';
    const payloadB64 = btoa(unescape(encodeURIComponent(rawHtml)));
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fcfcfc;display:flex;flex-direction:column}
  header{display:flex;align-items:center;gap:10px;height:52px;padding:0 18px;border-bottom:1px solid #e5e5e1;background:#fff;flex-shrink:0}
  header .title{font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
  header button{font-weight:600;font-size:13px;padding:8px 14px;border-radius:7px;cursor:pointer;flex-shrink:0}
  header .btn-primary{background:#2f6f4e;color:#fff;border:0}
  header .btn-primary:hover{opacity:.88}
  header .btn-ghost{background:transparent;color:#2f6f4e;border:1px solid #cfe3d7}
  header .btn-ghost:hover{background:#f2f8f4}
  header button:disabled{opacity:.6;cursor:default}
  #frame{border:0;width:100%;flex:1;display:block}
  @media print{header{display:none}}
</style></head>
<body>
<header><span class="title">${safeTitle}</span>
  <button id="dlpdf" class="btn-ghost" type="button">Download PDF</button>
  <button id="dl" class="btn-primary" type="button">Download HTML</button>
</header>
<iframe id="frame"></iframe>
<script>
(function () {
  var raw = decodeURIComponent(escape(atob(${JSON.stringify(payloadB64)})));

  var frame = document.getElementById('frame');
  var doc = frame.contentDocument || frame.contentWindow.document;
  doc.open();
  doc.write(raw);
  doc.close();

  document.getElementById('dl').addEventListener('click', function () {
    var blob = new Blob([raw], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = ${JSON.stringify(filename)};
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  });

  document.getElementById('dlpdf').addEventListener('click', function () {
    // Two attempts at printing through a nested off-screen iframe
    // (frame.contentWindow.print(), then a dedicated one with explicit
    // image-load waiting) both came out completely blank, with no change
    // between them - which points at the mechanism itself, not at timing.
    // window.print() on a genuine, separately opened top-level tab is a
    // fundamentally more reliable thing to ask a browser's print engine to
    // do than print() on a nested off-screen frame, and it costs nothing to
    // trust here: this is the exact same "open the raw document as its own
    // real navigation" technique the Open Clean Copy button already uses
    // successfully - this just skips the reader shell around it.
    var btn = this;
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Opening print tab…';

    var printUrl = URL.createObjectURL(new Blob([raw], { type: 'text/html;charset=utf-8' }));
    var printWin = window.open(printUrl, '_blank');
    if (!printWin) {
      btn.disabled = false;
      btn.textContent = original;
      alert("Couldn't open the print tab. Check this site's pop-up blocker setting.");
      URL.revokeObjectURL(printUrl);
      return;
    }

    function waitForImages(doc, timeoutMs) {
      return new Promise(function (resolve) {
        var imgs = [].slice.call(doc.images || []);
        if (!imgs.length) { resolve(); return; }
        var remaining = imgs.length;
        var settled = false;
        var settle = function () {
          if (settled) return;
          if (--remaining <= 0) { settled = true; resolve(); }
        };
        imgs.forEach(function (img) {
          if (img.complete) { settle(); return; }
          img.addEventListener('load', settle);
          img.addEventListener('error', settle);
        });
        setTimeout(function () { settled = true; resolve(); }, timeoutMs);
      });
    }

    function afterPaint(win, cb) {
      win.requestAnimationFrame(function () {
        win.requestAnimationFrame(cb);
      });
    }

    var triggered = false;
    var trigger = function () {
      if (triggered) return;
      triggered = true;
      waitForImages(printWin.document, 8000).then(function () {
        afterPaint(printWin, function () {
          printWin.focus();
          printWin.print();
          btn.disabled = false;
          btn.textContent = original;
          setTimeout(function () { URL.revokeObjectURL(printUrl); }, 60000);
        });
      });
    };

    // window.open() navigates asynchronously, so the new window's document
    // is not ready the instant it returns. Poll rather than rely on
    // printWin.onload: attaching that handler here can lose the race if the
    // blob navigation (already-local data, no network) finishes first.
    var pollId = setInterval(function () {
      try {
        if (printWin.document && printWin.document.readyState === 'complete') {
          clearInterval(pollId);
          trigger();
        }
      } catch (e) {
        /* not yet accessible - keep polling */
      }
    }, 100);
    setTimeout(function () { clearInterval(pollId); trigger(); }, 10000); // safety net
  });
})();
</script>
</body></html>`;
  }

  /**
   * Opens the full high-fidelity document in a new tab, wrapped in a small
   * reader shell with a real Download button - an actual file saved to disk,
   * not a print dialog standing in for one. The captured document still
   * carries the @media print / @page rules built into it, so printing it to
   * PDF from within that tab (Ctrl/Cmd+P) works too, if that's what's wanted.
   */
  function openOfflineTab(fullHtml, title) {
    showToast('Opening clean document in new tab…', 'success');
    const shellHtml = buildReaderShell(fullHtml, title);
    const blob = new Blob([shellHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
  }
})();
