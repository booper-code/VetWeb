// Client side of the Cloudflare R2 image service.
//
// Patient image fields hold one of three values:
//   - `data:image/...`  legacy inline base64 (still rendered until migrated)
//   - `https://...`     external image (seeded demo records, for example)
//   - `clinics/...`     R2 object key returned by the Worker
//
// The Worker verifies the Firebase ID token and the caller's clinic membership,
// then returns short-lived signed URLs. URLs are not shared between sessions.

import type { PatientRecord } from '@/types';
import { initializeFirebase } from '@/lib/firebase';
import { safeDirectImageUrl, safeSignedImageUrl } from '@/lib/imageValue';

const WORKER_URL = (process.env.NEXT_PUBLIC_IMAGE_WORKER_URL ?? '').replace(/\/+$/, '');
const BATCH_SIZE = 50;
const FLUSH_DELAY_MS = 20;

/** True when a Worker URL was provided at build time. */
export const imageStorageConfigured = () => Boolean(WORKER_URL);

export const isDataUrl = (value: string) => value.startsWith('data:');

export const isHttpUrl = (value: string) => /^https?:\/\//i.test(value);

export const isStoredImageKey = (value: string | null | undefined): value is string => {
  if (!value) return false;
  return !value.startsWith('data:') && !isHttpUrl(value) && value.startsWith('clinics/');
};

const getIdToken = async (): Promise<string> => {
  const { auth } = await initializeFirebase();
  const user = auth?.currentUser;
  if (!user) throw new Error('Sign in again to manage patient images.');
  return user.getIdToken();
};

const readErrorMessage = async (response: Response, fallback: string) => {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data.error === 'string' && data.error) return data.error;
  } catch {
    // The response was not JSON; use the caller's message.
  }
  return fallback;
};

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Could not read the image in this browser.'));
    reader.readAsDataURL(blob);
  });

/**
 * Uploads a compressed JPEG and returns the value to store on the patient
 * document. Demo mode and deployments without `NEXT_PUBLIC_IMAGE_WORKER_URL`
 * keep the old inline data URL behaviour, so the demo never needs the network.
 */
export const uploadPatientImage = async ({
  clinicId,
  patientId,
  blob
}: {
  clinicId: string | null | undefined;
  patientId: string;
  blob: Blob;
}): Promise<string> => {
  if (!WORKER_URL || !clinicId || clinicId === 'demo-clinic') {
    return blobToDataUrl(blob);
  }

  const token = await getIdToken();
  const form = new FormData();
  form.set('clinicId', clinicId);
  form.set('patientId', patientId || 'unassigned');
  form.set('file', blob, `${patientId || 'image'}-${Date.now()}.jpg`);

  let response: Response;
  try {
    response = await fetch(`${WORKER_URL}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });
  } catch (error) {
    console.error('[Images] Upload request failed:', error);
    throw new Error('Could not reach the image service. Check the connection and try again.');
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Image upload failed (${response.status}).`));
  }

  const data = (await response.json()) as { key?: unknown };
  if (typeof data.key !== 'string' || !isStoredImageKey(data.key)) {
    throw new Error('The image service returned an invalid storage key.');
  }

  return data.key;
};

// There is deliberately no client-side delete helper. The Worker's
// `DELETE /file` endpoint is disabled until a reference-aware cleanup process
// exists, so a delete call would only fail. Removing an image from a patient
// document leaves the R2 object in place on purpose; see
// workers/image-service/README.md before adding deletion back.

type Waiter = { resolve: (url: string | null) => void; reject: (error: unknown) => void };

const pending = new Map<string, Waiter[]>();
let flushScheduled = false;

const requestSignedUrls = async (keys: string[]): Promise<Record<string, string>> => {
  const token = await getIdToken();

  let response: Response;
  try {
    response = await fetch(`${WORKER_URL}/file-urls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ keys })
    });
  } catch (error) {
    console.error('[Images] Signed URL request failed:', error);
    throw new Error('Could not reach the image service.');
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Could not load images (${response.status}).`));
  }

  const data = (await response.json()) as { urls?: unknown };
  if (!data.urls || typeof data.urls !== 'object') return {};
  return data.urls as Record<string, string>;
};

const flushPending = async () => {
  const batch = Array.from(pending.keys()).slice(0, BATCH_SIZE);
  if (!batch.length) return;

  const entries = batch.map(key => [key, pending.get(key) ?? []] as const);
  for (const [key] of entries) pending.delete(key);

  try {
    const urls = await requestSignedUrls(batch);
    for (const [key, waiters] of entries) {
      const url = safeSignedImageUrl(urls[key], WORKER_URL, key);
      waiters.forEach(waiter => waiter.resolve(url));
    }
  } catch (error) {
    entries.forEach(([, waiters]) => waiters.forEach(waiter => waiter.reject(error)));
  } finally {
    if (pending.size) scheduleFlush();
  }
};

const scheduleFlush = () => {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(() => {
    flushScheduled = false;
    void flushPending();
  }, FLUSH_DELAY_MS);
};

/**
 * Resolves a stored key to a signed URL. Requests made in the same tick are
 * batched, so a patient list with many thumbnails does not send one request per
 * image. Returns the input unchanged for data and external URLs.
 */
export const resolveStoredImageUrl = (value: string): Promise<string | null> => {
  if (!isStoredImageKey(value)) return Promise.resolve(safeDirectImageUrl(value));
  if (!WORKER_URL) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const waiters = pending.get(value) ?? [];
    waiters.push({ resolve, reject });
    pending.set(value, waiters);
    scheduleFlush();
  });
};

/** Opens a signed image in a new tab without triggering the popup blocker. */
export const openStoredImage = async (value: string): Promise<void> => {
  if (!isStoredImageKey(value)) {
    const safeUrl = safeDirectImageUrl(value);
    if (!safeUrl) throw new Error('This image URL is not supported.');
    window.open(safeUrl, '_blank', 'noopener,noreferrer');
    return;
  }

  const win = window.open('', '_blank');
  if (!win) throw new Error('Allow pop-ups to open this image.');

  try {
    const url = await resolveStoredImageUrl(value);
    if (!url) throw new Error('This image is not available.');
    win.opener = null;
    win.location.href = url;
  } catch (error) {
    win.close();
    throw error;
  }
};

/** Every R2 key referenced by a patient record. */
export const patientImageKeys = (
  record: Pick<PatientRecord, 'profilePicture' | 'pictures' | 'labResults'>
): string[] => {
  const values = [
    record.profilePicture,
    ...(record.pictures ?? []),
    ...(record.labResults ?? []).map(lab => lab.imageUrl)
  ];

  return Array.from(new Set(values.filter(isStoredImageKey)));
};
