/**
 * Functions that run inside the page.
 *
 * In the Python version these lived as r""" ... """ string blobs - 290 lines of
 * JavaScript trapped inside another language, unlintable and unhighlightable.
 * Here they are ordinary functions handed to page.evaluate(), so they are real
 * code. They must stay self-contained: Playwright serialises the function
 * source, so nothing may close over module scope.
 */

/**
 * How many page containers exist, and how many have actually rendered.
 *
 * Scanned documents are an .image_layer holding one <img class="absimg">, and
 * Scribd only gives that img a src once the page is really brought into view.
 * Counting elements is not enough: a src-less <img> still reports
 * complete === true, so readiness has to mean naturalWidth > 0.
 */
export function pageStats() {
  const outers = [...document.querySelectorAll('[id^="outer_page_"]')].sort(
    (a, b) => +a.id.split('_').pop() - +b.id.split('_').pop()
  );
  const pages = outers.map((o) => {
    const n = +o.id.split('_').pop();
    const inner = document.getElementById('page' + n);
    const layer = inner ? inner.querySelector('.text_layer') : null;
    const text = layer ? layer.textContent.trim().length : 0;
    const imgEls = inner ? [...inner.querySelectorAll('img')] : [];
    const canvasEls = inner ? [...inner.querySelectorAll('canvas')] : [];
    const imgsLoaded = imgEls.filter((i) => i.naturalWidth > 0).length;
    const m = /width:\s*([\d.]+)px;\s*height:\s*([\d.]+)px/.exec(
      inner ? inner.getAttribute('style') || '' : ''
    );
    return {
      n,
      text,
      imgs: imgEls.length,
      canvases: canvasEls.length,
      imgsLoaded,
      w: m ? Math.round(+m[1]) : Math.round(o.getBoundingClientRect().width),
      h: m ? Math.round(+m[2]) : Math.round(o.getBoundingClientRect().height),
      // Same rule as readyOne: content present AND every image decoded.
      ready: (text > 0 || imgEls.length > 0 || canvasEls.length > 0) && imgsLoaded === imgEls.length,
    };
  });
  return {
    total: pages.length,
    ready: pages.filter((p) => p.ready).length,
    title: (document.title || '').replace(/\s*\|\s*PDF\s*$/i, '').trim(),
    pages,
  };
}

/**
 * True once one specific page has finished rendering.
 *
 * Every image must have decoded. Short-circuiting on "the text layer has text"
 * declares a page done while its inline figures are still src-less, and the
 * capture then drops them.
 */
export function readyOne(n) {
  const inner = document.getElementById('page' + n);
  if (!inner) return false;
  const imgs = [...inner.querySelectorAll('img')];
  if (!imgs.every((i) => i.naturalWidth > 0)) return false;
  const layer = inner.querySelector('.text_layer');
  const hasText = !!layer && layer.textContent.trim().length > 0;
  const canvases = [...inner.querySelectorAll('canvas')];
  return hasText || imgs.length > 0 || canvases.length > 0;
}

/**
 * Installed before any page script runs.
 *
 * Scribd registers a document's real fonts (ff0, ff1, ... - the families its
 * text layer actually asks for) through the JS FontFace API, not through
 * @font-face rules. They are therefore invisible to any amount of CSS
 * harvesting: document.fonts holds 46 faces while the stylesheets declare only
 * the two UI families. Without them a copy falls back to the stacks' next
 * entries - Comic Sans MS, Arial - so glyph widths shift, lines re-wrap, and
 * the result looks like text that was scraped and re-laid-out.
 *
 * Subclassing FontFace keeps a reference to every face the page registers.
 */
export function fontHook() {
  const Orig = window.FontFace;
  if (!Orig || window.__sdlFontHook) return;
  window.__sdlFontHook = true;
  window.__sdlFonts = [];
  class Hooked extends Orig {
    constructor(family, source, descriptors) {
      super(family, source, descriptors);
      try {
        window.__sdlFonts.push({
          family: String(family),
          source,
          descriptors: descriptors || {},
        });
      } catch (e) {
        /* never break the page over bookkeeping */
      }
    }
  }
  try {
    Object.defineProperty(Hooked, 'name', { value: 'FontFace' });
    window.FontFace = Hooked;
  } catch (e) {
    /* if it cannot be replaced, leave the original alone */
  }
}

/**
 * Serialises the hooked faces: binary sources become data URIs, url() sources
 * are handed back for the driver to fetch (an in-page fetch would hit CORS).
 */
export function fontDump() {
  const sniff = (b) => {
    const tag = String.fromCharCode(b[0], b[1], b[2], b[3]);
    if (tag === 'wOF2') return ['font/woff2', 'woff2'];
    if (tag === 'wOFF') return ['font/woff', 'woff'];
    if (tag === 'OTTO') return ['font/otf', 'opentype'];
    return ['font/ttf', 'truetype'];
  };
  const b64 = (bytes) => {
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  };
  const out = [];
  const seen = new Set();
  for (const rec of window.__sdlFonts || []) {
    const fam = String(rec.family || '')
      .replace(/["']/g, '')
      .trim();
    if (!fam) continue;
    const d = rec.descriptors || {};
    const key = fam + '|' + (d.weight || '') + '|' + (d.style || '');
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
      meta.cssSrc = rec.source;
      out.push(meta);
      continue;
    }
    try {
      const buf = rec.source && rec.source.buffer ? rec.source.buffer : rec.source;
      if (!buf || !buf.byteLength) continue;
      const bytes = new Uint8Array(buf);
      const sn = sniff(bytes);
      meta.dataUri = 'data:' + sn[0] + ';base64,' + b64(bytes);
      meta.format = sn[1];
      meta.bytes = bytes.length;
      out.push(meta);
    } catch (e) {
      /* skip a face we cannot read */
    }
  }
  return out;
}

/**
 * Harvests the raw material for an offline copy: page markup, the CSS the
 * document depends on, the absolute URLs of every asset, the ancestor chain and
 * the design tokens.
 *
 * Nothing is fetched here on purpose. An in-page fetch() to
 * html.scribdassets.com is cross-origin and gets refused by CORS, which
 * silently cost us every embedded image. Assets are downloaded by the driver
 * instead, through Playwright's request context, which shares the session
 * cookies but is not subject to CORS.
 */
export function capture() {
  const abs = (u) => {
    try {
      return new URL(u, location.href).href;
    } catch (e) {
      return null;
    }
  };

  // The per-document ffN font classes and .text_layer rules live in inline
  // <style> blocks; document-scoped sheets come from html.scribdassets.com.
  //
  // Harvest through the CSSOM rather than textContent: rules inserted with
  // insertRule() never show up in a <style> element's text, and serialising
  // cssRules yields strictly more (measured on a live document: 756 KB of
  // cssText against 700 KB of textContent).
  const cssParts = [];
  for (const s of document.querySelectorAll('style')) {
    let text = '';
    try {
      if (s.sheet && s.sheet.cssRules && s.sheet.cssRules.length) {
        text = [...s.sheet.cssRules].map((r) => r.cssText).join('\n');
      }
    } catch (e) {
      /* unreadable sheet - fall back to the element's text */
    }
    cssParts.push(text || s.textContent || '');
  }
  const inlineCss = cssParts.join('\n');

  const sheetUrls = [...document.querySelectorAll('link[rel="stylesheet"]')]
    .map((l) => l.href)
    .filter((h) => /html\.scribdassets\.com/.test(h));

  // Scribd writes its page rules against --spl-* design tokens
  //   ._3Ilj5i .outer_page{background-color:var(--spl-color-background-primary);
  //                        border:var(--spl-borderwidth-100) solid var(...)}
  // but those tokens are declared in no harvestable stylesheet, so copying CSS
  // alone can never carry them. Left undefined, each var() is invalid at
  // computed-value time and the page silently loses its background and border.
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

  const outers = [...document.querySelectorAll('[id^="outer_page_"]')].sort(
    (a, b) => +a.id.split('_').pop() - +b.id.split('_').pop()
  );

  const blocks = [];
  const sizes = [];
  const skipped = [];
  const blank = [];
  const images = new Set();
  let droppedImgs = 0;

  for (const outer of outers) {
    const n = +outer.id.split('_').pop();
    const inner = document.getElementById('page' + n);
    if (!inner) {
      skipped.push(n);
      continue;
    }

    const layer = inner.querySelector('.text_layer');
    const hasText = !!layer && layer.textContent.trim().length > 0;
    const liveImgs = [...inner.querySelectorAll('img')];
    const liveCanvases = [...inner.querySelectorAll('canvas')];
    const loadedImgs = liveImgs.filter((i) => i.naturalWidth > 0);
    if (!hasText && liveImgs.length === 0 && liveCanvases.length === 0) {
      skipped.push(n);
      continue;
    }
    // A scanned page is nothing but its image. If that image never got a src,
    // emitting the page would produce a silently blank sheet - so report it.
    if (!hasText && loadedImgs.length === 0 && liveCanvases.length === 0) {
      blank.push(n);
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

    // Convert any live <canvas> elements into <img> elements with data URIs
    // because cloned <canvas> elements are blank (cloneNode does not copy pixel buffer).
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

    // Fast in-memory canvas extraction to avoid redundant network re-downloads
    const extractImageToDataUri = (imgEl) => {
      try {
        if (!imgEl || !imgEl.naturalWidth || !imgEl.naturalHeight) return null;
        const c = document.createElement('canvas');
        c.width = imgEl.naturalWidth;
        c.height = imgEl.naturalHeight;
        const ctx = c.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(imgEl, 0, 0);
        const s = (imgEl.currentSrc || imgEl.src || '').toLowerCase();
        const isPng = s.includes('.png') || s.includes('.svg');
        return c.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.90);
      } catch (e) {
        return null;
      }
    };

    // Pair the clone's <img> with the live element.
    // Use the built-in browser canvas directly whenever available!
    const cloneImgs = clone.querySelectorAll('img');
    for (let i = 0; i < cloneImgs.length; i++) {
      const live = liveImgs[i];
      const ok = live && live.naturalWidth > 0;
      if (ok) {
        const directData = extractImageToDataUri(live);
        if (directData) {
          cloneImgs[i].setAttribute('src', directData);
          continue; // Successfully inlined via built-in browser canvas!
        }
      }
      const src = ok ? live.currentSrc || live.src : '';
      const a = src && src.indexOf('data:') !== 0 ? abs(src) : src;
      if (a) {
        cloneImgs[i].setAttribute('src', a);
        images.add(a);
      } else {
        cloneImgs[i].remove();
        droppedImgs++;
      }
    }

    // Keep Scribd's own wrapper, its full class list and its ids, so the
    // harvested .outer_page rules style the page box exactly as Scribd does.
    // The only thing we override is the size, because we undid the scale.
    const cls = (outer.className || '').toString().trim() || 'outer_page';
    blocks.push(
      '<div class="' +
        cls +
        '" id="outer_page_' +
        n +
        '" style="width:' +
        w +
        'px;height:' +
        h +
        'px">' +
        clone.outerHTML +
        '</div>'
    );
  }

  // Scribd styles its pages through descendant selectors keyed on hashed
  // wrapper classes - "._3Ilj5i .outer_page {...}" - whose values are --spl-*
  // tokens scoped to those same ancestors. A bare page div matches none of it.
  const chain = [];
  {
    const first = document.querySelector('[id^="outer_page_"]');
    let el = first ? first.parentElement : null;
    while (el && el !== document.body && el !== document.documentElement) {
      chain.unshift({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().trim(),
        id: el.id || '',
      });
      el = el.parentElement;
    }
  }
  const dataAttrs = (el) => {
    const o = {};
    for (const a of el.attributes) {
      if (a.name.indexOf('data-') === 0) o[a.name] = a.value;
    }
    return o;
  };

  return {
    blocks,
    sizes,
    skipped,
    blank,
    droppedImgs,
    inlineCss,
    sheetUrls,
    images: [...images].filter((u) => u.indexOf('data:') !== 0),
    base: location.href,
    chain,
    vars,
    htmlClass: (document.documentElement.className || '').toString().trim(),
    bodyClass: (document.body.className || '').toString().trim(),
    htmlData: dataAttrs(document.documentElement),
    bodyData: dataAttrs(document.body),
    lang: document.documentElement.getAttribute('lang') || 'en',
  };
}
