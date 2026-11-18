'use client';

import { useEffect, useState } from 'react';
import { clearOfflineDeviceData, getFirebaseDeviceState } from '@/lib/firebase';
import { getDevicePreference, requestTrustedDevice, watchDevicePreference, getDeviceClearState, setDeviceClearState, DEVICE_CLEAR_EVENT } from '@/lib/offline-device';

export default function OfflineDeviceSettings({ beforeClear }: { beforeClear?: () => void | Promise<void> }) {
  const [trusted, setTrusted] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [clearState, setClearState] = useState(getDeviceClearState);
  useEffect(() => {
    const update = () => setTrusted(getDevicePreference() === 'trusted');
    update();
    return watchDevicePreference(update);
  }, []);
  useEffect(() => {
    const update = () => setClearState(getDeviceClearState());
    window.addEventListener(DEVICE_CLEAR_EVENT, update);
    return () => window.removeEventListener(DEVICE_CLEAR_EVENT, update);
  }, []);

  async function clear() {
    if (!window.confirm('Sign out and erase cached clinical records on this device? Unsynced local writes may be lost. Save any work first and close other VetWeb tabs.')) return;
    setBusy(true);
    try {
      await beforeClear?.();
      await clearOfflineDeviceData();
      setMessage('Device data cleared and signed out. Restart the app when ready.');
    } catch {
      setMessage('Could not confirm all device data was cleared. Close other VetWeb tabs and retry. Do not leave this device unattended until clearing succeeds.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="offline-device-title" className="rounded-xl border border-outline-soft bg-panel p-4 text-sm text-content-heading">
      <h2 id="offline-device-title" className="font-bold">Offline device privacy</h2>
      <p className="my-2">Shared devices use memory only. Trusted-device storage keeps clinical records and your sign-in on this browser between visits. Anyone with access to this browser profile may access them. It is not a backup.</p>
      <p>{trusted ? 'Trusted-device storage requested.' : 'Memory-only storage selected.'}</p>
      {!trusted && !getFirebaseDeviceState().restartRequired && (
        <>
          <label className="my-3 flex items-start gap-2">
            <input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
            This is my secured, private device. I consent to storing clinical records and sign-in locally.
          </label>
          <button className="rounded border px-3 py-2 disabled:opacity-50" disabled={!consent || busy} onClick={() => {
            try {
              requestTrustedDevice(true);
              setMessage('Opt-in saved. Finish your work, then restart and sign in to activate storage.');
            } catch {
              setMessage('This browser cannot save device consent. Memory-only storage remains active.');
            }
          }}>Enable on next start</button>
        </>
      )}
      <button className="m-2 rounded border px-3 py-2 disabled:opacity-50" disabled={busy} onClick={() => void clear()}>
        {busy ? 'Clearing…' : 'Disable, sign out & clear device data'}
      </button>
      <p role="status">{clearState.phase !== 'idle' ? clearState.message : message || getFirebaseDeviceState().persistenceNotice}</p>
      {clearState.phase === 'cleared' && (
        <button className="mt-2 rounded border px-3 py-2" onClick={() => setDeviceClearState({ phase: 'idle', message: '' })}>
          Dismiss status
        </button>
      )}
      <p className="mt-2 text-xs">Offline clinical work must remain read-only. Storage does not guarantee synchronization. Updates wait for open tabs to close; this control never reloads your work.</p>
    </section>
  );
}
