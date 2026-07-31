import { protocol } from 'electron';
import path from 'path';
import { promises as fsp } from 'fs';
import { fileURLToPath } from 'url';
import { isInside } from './guards.mjs';

// ---- The app:// scheme ----
//
// The UI is served from a custom scheme rather than loaded off disk with
// loadFile(). Chromium refuses a `<script type="module">` from a file:// page —
// module fetches go through CORS and a file:// origin is opaque — so the renderer
// could not be split into ES modules at all while the window loaded file://.
//
// `standard` is what gives the scheme real origin semantics: relative URLs
// resolve, and localStorage works (which is where the view mode and the divider
// positions live). `secure` keeps it out of Chromium's mixed-content and
// restricted-API buckets, the same as https.
const APP_SCHEME = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://wisp`;
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true } },
]);

// Served content types. A module script is subject to strict MIME checking —
// Chromium refuses to execute one that doesn't arrive as JavaScript — so these
// are stated rather than guessed.
const CONTENT_TYPE: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// The repo root — one level up from this module. Inside a packaged build that is
// app.asar, which fs reads through transparently.
const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Serve the app's own directory, and nothing else: the request path is resolved
// against APP_ROOT and refused if it escapes — the same guard the vault handlers
// apply, for the same reason.
export function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const file = path.join(APP_ROOT, rel || 'index.html');
    if (!isInside(APP_ROOT, file)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fsp.readFile(file);
      const type = CONTENT_TYPE[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return new Response(body, { headers: { 'content-type': type } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
