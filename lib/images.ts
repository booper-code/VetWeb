// Client-side image handling for patient photos and lab printouts.
//
// New uploads are compressed and sent to the Cloudflare R2 image service, which
// returns an object key that is stored on the patient document. Legacy records
// still contain base64 data URLs (Firestore has a hard 1 MiB document limit), so
// every upload is re-encoded down to a display-sized JPEG before it leaves the
// browser. `MAX_PATIENT_DOC_BYTES` remains a guard for those legacy records.

/** Firestore rejects documents above 1 MiB. Keep a margin for field overhead. */
export const MAX_PATIENT_DOC_BYTES = 900 * 1024;

/** Profile avatars are only ever shown at thumbnail size. */
export const PROFILE_IMAGE_OPTIONS = { maxDimension: 800, quality: 0.72 };

/** Lab printouts need enough resolution for the text to stay legible. */
export const DOCUMENT_IMAGE_OPTIONS = { maxDimension: 1600, quality: 0.8 };

export type EncodedImage = {
  dataUrl: string;
  bytes: number;
  width: number;
  height: number;
};

/** A compressed upload plus the data URL used for an immediate local preview. */
export type CompressedImageBlob = {
  blob: Blob;
  previewUrl: string;
  bytes: number;
  width: number;
  height: number;
};

type CompressOptions = {
  maxDimension: number;
  quality: number;
};

/** Byte length of the base64 payload inside a data URL. */
export const dataUrlBytes = (dataUrl: string) => {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return dataUrl.length;
  const base64 = dataUrl.slice(comma + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
};

/** Exact UTF-8 size of a value as Firestore will serialize it. */
export const firestoreDocBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const loadBitmap = async (file: File): Promise<ImageBitmap | HTMLImageElement> => {
  if (typeof createImageBitmap === 'function') {
    try {
      // Honour EXIF rotation so phone photos are not stored sideways.
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      return await createImageBitmap(file);
    }
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Unsupported image format'));
    };
    image.src = url;
  });
};

/**
 * Re-encode an uploaded image as a JPEG bounded by `maxDimension`, which keeps
 * patient documents comfortably inside the Firestore size limit.
 */
export const compressImageFile = async (
  file: File,
  options: CompressOptions = PROFILE_IMAGE_OPTIONS
): Promise<EncodedImage> => {
  const source = await loadBitmap(file);
  const sourceWidth = source.width;
  const sourceHeight = source.height;

  if (!sourceWidth || !sourceHeight) {
    throw new Error('Image has no dimensions');
  }

  const scale = Math.min(1, options.maxDimension / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas is unavailable in this browser');
  }

  // JPEG has no alpha channel: flatten transparency onto white instead of black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);

  if ('close' in source && typeof source.close === 'function') {
    source.close();
  }

  const dataUrl = canvas.toDataURL('image/jpeg', options.quality);

  return { dataUrl, bytes: dataUrlBytes(dataUrl), width, height };
};

/**
 * Same compression as `compressImageFile`, but also returns the JPEG as a Blob
 * for upload to the image service. The data URL is only a preview and is never
 * written to Firestore when the image service is configured.
 */
export const compressImageFileToBlob = async (
  file: File,
  options: CompressOptions = PROFILE_IMAGE_OPTIONS
): Promise<CompressedImageBlob> => {
  const encoded = await compressImageFile(file, options);
  const blob = await (await fetch(encoded.dataUrl)).blob();

  return {
    blob,
    previewUrl: encoded.dataUrl,
    bytes: blob.size,
    width: encoded.width,
    height: encoded.height
  };
};
