"use client";

import { useEffect, useState } from 'react';
import { subscribeClinicImageUploads, setClinicImageUploadsEnabled } from '@/lib/clinics';

export function ImageStorageControls({ clinicId, online }: { clinicId: string; online: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void subscribeClinicImageUploads(clinicId, value => { if (active) setEnabled(value); },
      () => { if (active) setError('Could not load image storage settings.'); })
      .then(unsubscribe => { if (active) stop = unsubscribe; else unsubscribe(); })
      .catch(() => { if (active) setError('Could not load image storage settings.'); });
    return () => { active = false; stop?.(); };
  }, [clinicId]);
  return <section className="my-4 space-y-3 rounded-xl border border-outline-soft bg-panel p-4 text-sm">
    <h2 className="font-bold text-content-title">Image storage safeguards</h2>
    <label className="flex items-center justify-between gap-3">
      Allow new image uploads
      <input type="checkbox" role="switch" aria-label="Allow new image uploads" checked={enabled === true}
        disabled={enabled === null || busy || !online} onChange={async event => {
          setBusy(true); setError('');
          try { await setClinicImageUploadsEnabled(clinicId, event.target.checked); }
          catch { setError('Could not update the upload setting. Nothing was changed.'); }
          finally { setBusy(false); }
        }} />
    </label>
    <p className="text-content-secondary">Owners can pause uploads without deleting existing images. The server enforces this setting. Each file is capped at 5 MB, with per-user and per-clinic rate limits.</p>
    <p className="text-xs text-warning-text">Rate limits are approximate per location, not a global byte quota. Monitor R2 usage in Cloudflare and pause uploads before exhausting your free allocation.</p>
    {error && <p role="alert" className="text-danger-text">{error}</p>}
  </section>;
}
