/**
 * Scribd Reader Extension - Font Hook
 *
 * Runs in the page's own MAIN world (see manifest.json's "world": "MAIN"),
 * auto-injected at document_start on every scribd.com page, before Scribd's
 * own bundle runs. Its job is to intercept FontFace construction so the
 * document's real fonts (ff0, ff1, ... - the families the text layer
 * actually asks for) can be captured later, if the user opens the popup and
 * exports the page.
 *
 * This has to run this early, and it has to run in the MAIN world
 * specifically. Scribd registers those fonts through the JS FontFace API
 * rather than through @font-face rules, so document.fonts holds no trace of
 * where the bytes came from once a face has already been constructed -
 * nothing that runs after the fact (content.js, injected only when the
 * popup is opened) can retrieve them retroactively. And a content script's
 * *default* isolated world has its own separate copy of built-ins like
 * FontFace: overwriting window.FontFace there does not touch the one
 * Scribd's own script - running in the main world - actually calls. Only a
 * main-world hook sees the real construction calls.
 *
 * content.js runs in the isolated world (it needs chrome.runtime, which
 * main-world scripts cannot use at all), so the two do not share a global
 * object either - only the DOM. The captured list is handed across that
 * boundary via a DOM CustomEvent round trip: content.js dispatches a
 * "request" event, this script answers with a "response" event carrying the
 * data. CustomEvent detail is structured-cloned across the world boundary,
 * same as postMessage, so plain objects and ArrayBuffers survive intact.
 */
(function () {
  if (window.__sdlFontHookInstalled) return;
  window.__sdlFontHookInstalled = true;

  const captured = [];
  const Orig = window.FontFace;

  if (Orig) {
    class Hooked extends Orig {
      constructor(family, source, descriptors) {
        super(family, source, descriptors);
        try {
          captured.push({
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
      /* if it cannot be replaced, leave the original alone - captured stays empty */
    }
  }

  window.addEventListener('__sdlDumpFontsRequest', () => {
    window.dispatchEvent(new CustomEvent('__sdlDumpFontsResponse', { detail: captured }));
  });
})();
