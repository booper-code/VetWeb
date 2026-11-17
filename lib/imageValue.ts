/** Only passive raster data or encrypted external URLs may reach image UI. */
export const safeDirectImageUrl = (value: string | null | undefined): string | null => {
  if (!value || value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value)) return null;
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value)) {
    return value;
  }
  if (!/^https:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? value : null;
  } catch {
    return null;
  }
};

/** Worker responses cannot redirect image popups to unrelated origins or keys. */
export const safeSignedImageUrl = (value: unknown, workerUrl: string, key: string): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const worker = new URL(workerUrl);
    const url = new URL(value);
    return ['https:', 'http:'].includes(worker.protocol) &&
      url.origin === worker.origin && url.pathname === '/file' &&
      !url.username && !url.password && url.searchParams.get('key') === key
      ? value : null;
  } catch {
    return null;
  }
};
