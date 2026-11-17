/* Only a build-generated, unauthenticated static-export shell is cached.
 * No runtime HTML, API/RSC payloads, images, tokens, or cross-origin requests.
 * No skipWaiting/clients.claim/reload: updates wait for existing tabs to close.
 */
const CACHE_PREFIX = 'vetcloud-shell-v1-';
const FIXED_ASSETS = new Set(['/manifest.webmanifest', '/icons/vetcloud.svg']);
const build = new URL(self.location.href).searchParams.get('build');
const cacheName = /^[a-f0-9]{64}$/.test(build || '') ? CACHE_PREFIX + build : null;

function isStaticAsset(url, origin) {
  return url.origin === origin && !url.search && !url.hash &&
    (FIXED_ASSETS.has(url.pathname) ||
      /^\/_next\/static\/[a-zA-Z0-9_./-]+\.(?:js|css|woff2?)$/.test(url.pathname));
}

function canHandle(request, origin) {
  if (request.method !== 'GET' || request.headers.has('authorization') || request.headers.has('range')) return false;
  const url = new URL(request.url);
  return isStaticAsset(url, origin) ||
    (url.origin === origin && url.pathname === '/' && !url.search && request.mode === 'navigate');
}

function cacheable(response) {
  return response.ok && response.type === 'basic' && !response.redirected &&
    !/\b(?:private|no-store)\b/i.test(response.headers.get('cache-control') || '');
}

async function activeCache() {
  return cacheName ? caches.open(cacheName) : null;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    if (!cacheName) throw new Error('Production build identity required');
    const response = await fetch('/', { credentials: 'omit', cache: 'no-store', redirect: 'error' });
    if (!cacheable(response)) throw new Error('Static shell unavailable');
    const html = await response.clone().text();
    if (!/<meta\s+name="vetcloud-static-shell"\s+content="1"\s*\/?>/.test(html)) {
      throw new Error('Only static exports support this offline shell');
    }
    // Do not let a background worker update replace an older tab's shell with
    // a different deployment. Each public build has an isolated cache.
    const scripts = Array.from(html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g))
      .map(match => new URL(match[1].replaceAll('&amp;', '&'), self.location.origin))
      .filter(url => url.origin === self.location.origin && url.pathname.startsWith('/_next/static/'))
      .map(url => url.pathname).sort().join('\n');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scripts));
    const shellBuild = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (shellBuild !== build) throw new Error('Deployment changed; reopen online to install its shell');
    const cache = await caches.open(cacheName);
    const assets = new Set(FIXED_ASSETS);
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const url = new URL(match[1].replaceAll('&amp;', '&'), self.location.origin);
      if (isStaticAsset(url, self.location.origin)) assets.add(url.pathname);
    }
    // Commit the shell only after its directly referenced assets are present.
    await Promise.all(Array.from(assets, async path => {
      const asset = await fetch(path, { credentials: 'omit', cache: 'reload', redirect: 'error' });
      if (!cacheable(asset)) throw new Error('Static asset unavailable');
      await cache.put(path, asset);
    }));
    await cache.put('/', response);
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    if (!cacheName) return;
    await Promise.all((await caches.keys()).filter(name => name.startsWith(CACHE_PREFIX) && name !== cacheName).map(name => caches.delete(name)));
  })());
});

self.addEventListener('fetch', event => {
  if (!canHandle(event.request, self.location.origin)) return;
  event.respondWith((async () => {
    const cache = await activeCache();
    const url = new URL(event.request.url);
    if (event.request.mode === 'navigate') {
      // Never cache a navigation response: only install's anonymous static HTML.
      try { return await fetch(event.request); }
      catch { return (await cache?.match('/')) || Response.error(); }
    }
    const existing = await cache?.match(url.pathname);
    if (existing) return existing;
    const response = await fetch(url.pathname, { credentials: 'omit', redirect: 'error' });
    if (cache && cacheable(response)) await cache.put(url.pathname, response.clone());
    return response;
  })());
});
