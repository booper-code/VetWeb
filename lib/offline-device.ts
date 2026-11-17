/** Stores consent only. Never store identities, records, tokens, or drafts here. */
const DEVICE_KEY = 'vetcloud.trusted-device.v1';
const WIPE_KEY = 'vetcloud.device-wipe.v1';
const WIPE_CHANNEL = 'vetcloud-device-wipe';
export const DEVICE_SETTINGS_EVENT = 'vetcloud-device-settings';
export const DEVICE_CLEAR_EVENT = 'vetcloud-device-clear-status';
export type DevicePreference = 'memory' | 'trusted';
export type DeviceChange = 'preference' | 'wipe';
export type DeviceClearState = { phase: 'idle' | 'clearing' | 'cleared' | 'failed'; message: string };
let clearState: DeviceClearState = { phase: 'idle', message: '' };
export const getDeviceClearState = () => clearState;
export const setDeviceClearState = (state: DeviceClearState) => {
  clearState = state;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DEVICE_CLEAR_EVENT));
};

export function getDevicePreference(): DevicePreference {
  if (typeof window === 'undefined') return 'memory';
  try {
    return window.localStorage.getItem(DEVICE_KEY) === 'trusted' ? 'trusted' : 'memory';
  } catch {
    return 'memory';
  }
}

/** Applies on the next page load; never reloads or interrupts a draft. */
export function requestTrustedDevice(enabled: boolean): void {
  if (enabled) window.localStorage.setItem(DEVICE_KEY, 'trusted');
  else window.localStorage.removeItem(DEVICE_KEY);
  window.dispatchEvent(new Event(DEVICE_SETTINGS_EVENT));
}

/** A distinct nonce reaches memory-mode tabs even when no consent key existed. */
export function broadcastDeviceWipe(): void {
  try { window.localStorage.setItem(WIPE_KEY, `${Date.now()}-${Math.random()}`); } catch { /* BroadcastChannel remains available in some restricted contexts. */ }
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(WIPE_CHANNEL);
      channel.postMessage('wipe');
      channel.close();
    }
  } catch { /* The storage signal is the fallback. */ }
  window.dispatchEvent(new CustomEvent(DEVICE_SETTINGS_EVENT, { detail: 'wipe' }));
}

export function watchDevicePreference(listener: (change: DeviceChange) => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === WIPE_KEY) listener('wipe');
    else if (event.key === DEVICE_KEY || event.key === null) listener('preference');
  };
  const onLocal = (event: Event) => listener((event as CustomEvent).detail === 'wipe' ? 'wipe' : 'preference');
  let channel: BroadcastChannel | undefined;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(WIPE_CHANNEL);
      channel.onmessage = event => { if (event.data === 'wipe') listener('wipe'); };
    }
  } catch { /* Storage events still work when channels are unavailable. */ }
  window.addEventListener('storage', onStorage);
  window.addEventListener(DEVICE_SETTINGS_EVENT, onLocal);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(DEVICE_SETTINGS_EVENT, onLocal);
    channel?.close();
  };
}

/** Connectivity is only a UI hint, not proof a backend write will succeed. */
export function isDeviceOnline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine;
}
