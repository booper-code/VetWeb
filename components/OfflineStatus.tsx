'use client';

import { useEffect, useState } from 'react';

/** Shell registration only: no record caching or automatic update activation. */
export default function OfflineStatus({ staticShell }: { staticShell: boolean }) {
  const [offline, setOffline] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    let disposed = false;
    if (process.env.NODE_ENV === 'production' && staticShell && 'serviceWorker' in navigator) {
      const register = async () => {
        // Build identity contains only public JS paths, never DOM/clinical content.
        const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))
          .map(script => new URL(script.src))
          .filter(url => url.origin === location.origin && url.pathname.startsWith('/_next/static/'))
          .map(url => url.pathname).sort().join('\n');
        if (!scripts) throw new Error('Build assets unavailable');
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scripts));
        const build = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        return navigator.serviceWorker.register(`/sw.js?build=${build}`, { scope: '/', updateViaCache: 'none' });
      };
      void register().then(registration => {
        const waiting = () => {
          if (!disposed && registration.waiting) setNotice('An app update is ready. Finish your work and close all VetWeb tabs to apply it.');
        };
        waiting();
        registration.addEventListener('updatefound', () => {
          registration.installing?.addEventListener('statechange', waiting);
        });
      }).catch(() => {
        if (!disposed) setNotice('Offline app shell is unavailable in this browser.');
      });
    }
    return () => {
      disposed = true;
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [staticShell]);
  if (!offline && !notice) return null;
  return (
    <>
      {offline && (
        <div
          role="status"
          aria-live="polite"
          className="vc-offline-banner sticky top-0 z-50 border-b border-warning-stroke bg-warning-wash px-4 py-2 text-center text-sm text-warning-text-max"
        >
          <p className="font-bold">No internet connection</p>
          <p>Clinic data is read-only until the connection returns. Clinic changes require a connection. The fictional demo can run offline.</p>
        </div>
      )}
      {notice && (
        <div role="status" className="border-b border-warning-stroke bg-warning-wash px-4 py-2 text-center text-sm text-warning-text-max">
          {notice}
        </div>
      )}
    </>
  );
}
