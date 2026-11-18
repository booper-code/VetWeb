export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'vetcloud.appearance.v1';
const SYSTEM_DARK = '(prefers-color-scheme: dark)';
const THEME_CHANGE = 'vetcloud-appearance-change';
let transitionEpoch = 0;

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

// Keep this script synchronous and independent of the client bundle. Only fixed
// constants are interpolated; neither persisted data nor user input is markup.
export const themeInitScript = `(() => {
  let saved;
  try { saved = window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}); } catch {}
  const preference = saved === 'light' || saved === 'dark' ? saved : 'system';
  const root = document.documentElement;
  root.dataset.themePreference = preference;
  root.dataset.theme = preference === 'system'
    ? (window.matchMedia?.(${JSON.stringify(SYSTEM_DARK)})?.matches ? 'dark' : 'light')
    : preference;
})();`;

const systemMedia = () => window.matchMedia?.(SYSTEM_DARK);

export function getThemePreference(): ThemePreference {
  return typeof document === 'undefined' ? 'system' : normalizeThemePreference(document.documentElement.dataset.themePreference);
}

function applyTheme(preference: ThemePreference, media = systemMedia()) {
  const root = document.documentElement;
  const resolved = preference === 'system' ? (media?.matches ? 'dark' : 'light') : preference;
  root.dataset.themePreference = preference;
  if (root.dataset.theme === resolved) return;

  // Change text and its surface on the same frame; normal hover transitions
  // otherwise crossfade the surface after the foreground has already changed.
  const epoch = ++transitionEpoch;
  root.dataset.themeChanging = '';
  root.dataset.theme = resolved;
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    if (epoch === transitionEpoch) delete root.dataset.themeChanging;
  }));
}

export function setThemePreference(preference: ThemePreference) {
  applyTheme(preference);
  try { window.localStorage.setItem(THEME_STORAGE_KEY, preference); } catch { /* Keep the document override when storage is unavailable. */ }
  window.dispatchEvent(new Event(THEME_CHANGE));
}

export function subscribeThemePreference(onChange: () => void) {
  const media = systemMedia();
  const syncSystem = () => {
    if (getThemePreference() === 'system') applyTheme('system', media);
  };
  const syncStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    applyTheme(normalizeThemePreference(event.newValue), media);
    onChange();
  };
  syncSystem();
  media?.addEventListener('change', syncSystem);
  window.addEventListener('storage', syncStorage);
  window.addEventListener(THEME_CHANGE, onChange);
  return () => {
    media?.removeEventListener('change', syncSystem);
    window.removeEventListener('storage', syncStorage);
    window.removeEventListener(THEME_CHANGE, onChange);
  };
}
