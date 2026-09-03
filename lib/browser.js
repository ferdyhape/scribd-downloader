/**
 * Browser selection.
 *
 * This stack uses playwright-core, which downloads nothing: it drives a browser
 * already on the machine. That is the whole point of the Node port - Playwright's
 * bundled browsers weigh 703 MB (chromium 428 MB plus chromium_headless_shell
 * 272 MB), and the Python package carried another 102 MB of bundled Node just to
 * run the driver we now are.
 *
 * The trade-off, stated plainly: there is no bundled fallback here. An installed
 * Chrome or Edge is required, and the error says so rather than failing obscurely.
 *
 * Override with SCRIBD_DL_CHANNEL=chrome|msedge, or point
 * SCRIBD_DL_EXECUTABLE at a binary directly.
 */

import fs from 'node:fs';
import { chromium } from 'playwright-core';

const CHANNELS = ['chrome', 'chromium', 'msedge'];
const KNOWN_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];
export const SERVER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--renderer-process-limit=1',
  '--js-flags=--max-old-space-size=256',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-component-extensions-with-background-pages',
  '--disable-extensions',
  '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
  '--disable-ipc-flooding-protection',
  '--disable-sync',
  '--mute-audio',
  '--no-default-browser-check',
  '--no-first-run',
];

const cache = new Map();

/**
 * Pick a browser channel to drive. Returns launch options to spread into
 * chromium.launch() / launchPersistentContext().
 */
export async function resolveBrowser(preferred = '') {
  const want = (preferred || process.env.SCRIBD_DL_CHANNEL || 'auto').toLowerCase();
  if (cache.has(want)) return cache.get(want);

  const exe = process.env.SCRIBD_DL_EXECUTABLE;
  if (exe) {
    const opts = { executablePath: exe };
    cache.set(want, opts);
    return opts;
  }

  const candidates = want === 'auto' ? CHANNELS : [want];
  for (const channel of candidates) {
    try {
      // A probe launch is the only honest test that a channel really works.
      const browser = await chromium.launch({ channel, headless: true, args: SERVER_ARGS });
      await browser.close();
      const opts = { channel };
      cache.set(want, opts);
      return opts;
    } catch {
      /* try the next one */
    }
  }

  // If no channel worked, check known system paths on Linux
  if (want === 'auto') {
    for (const exePath of KNOWN_PATHS) {
      if (fs.existsSync(exePath)) {
        try {
          const browser = await chromium.launch({ executablePath: exePath, headless: true, args: SERVER_ARGS });
          await browser.close();
          const opts = { executablePath: exePath };
          cache.set(want, opts);
          return opts;
        } catch {
          /* try next */
        }
      }
    }
  }

  throw new Error(
    `No usable browser found (tried channels: ${candidates.join(', ')}).\n` +
      'This build drives an installed Chrome, Chromium, or Edge.\n' +
      'On Linux/VPS, install one via:\n' +
      '  sudo apt update && sudo apt install -y chromium-browser\n' +
      'or set SCRIBD_DL_EXECUTABLE=/path/to/chromium in your .env file.'
  );
}

/** Launch a throwaway headless browser on the resolved channel. */
export async function launchHeadless() {
  const resolved = await resolveBrowser();
  return chromium.launch({
    headless: true,
    ...resolved,
    args: [...SERVER_ARGS, ...(resolved.args || [])],
  });
}

export { chromium };
