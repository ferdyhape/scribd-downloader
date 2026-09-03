/**
 * Scribd Downloader Extension - Background Service Worker
 *
 * The offline/PDF export used to re-encode <img> elements through a canvas
 * (drawImage + toDataURL). That silently fails for every page-raster image:
 * they load from html.scribdassets.com, a different origin than scribd.com,
 * and without a crossorigin="anonymous" attribute on the <img> - which
 * Scribd's own markup never sets - the HTML/Canvas spec taints that canvas
 * unconditionally, regardless of what CORS headers the image server sends.
 * canvas.toDataURL() then throws, and the code fell back to keeping the
 * live scribdassets.com URL - meaning the "offline" export wasn't actually
 * offline: it depended on a signed, expiring URL staying reachable.
 *
 * A service worker's own fetch() is not subject to that page-level taint
 * rule at all - it's a plain network request, and with scribdassets.com
 * declared in host_permissions, Chrome grants it cross-origin access. This
 * mirrors exactly what lib/capture.js's dataUri() does server-side: fetch
 * the real bytes through a privileged context, never a canvas.
 */

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Fetch one URL as a data URI, retrying transient failures. Matches the
 * retry shape of lib/capture.js's dataUri(): a hard 4xx (other than 429)
 * is not retried, since it will not improve. */
async function fetchAsDataUri(url, attempts = 3) {
  let lastError = 'failed';
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        const contentType = resp.headers.get('content-type') || 'application/octet-stream';
        return { dataUri: `data:${contentType};base64,${arrayBufferToBase64(buf)}` };
      }
      lastError = `HTTP ${resp.status}`;
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) break;
    } catch (err) {
      lastError = `${err.name}: ${err.message}`;
    }
    if (attempt + 1 < attempts) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return { error: lastError };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'FETCH_AS_DATA_URI' && request.url) {
    fetchAsDataUri(request.url).then(sendResponse);
    return true; // async response
  }
  return false;
});
