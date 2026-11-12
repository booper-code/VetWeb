"use client";

// Signed R2 URLs expire and data URLs cannot be optimized by next/image, so a
// plain <img> is the right primitive here.
/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from 'react';
import { isStoredImageKey, resolveStoredImageUrl } from '@/lib/imageStore';

const EMPTY_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

/**
 * Renders any patient image value: a legacy data URL, an external URL, or an R2
 * object key. Keys are resolved to short-lived signed URLs in the background.
 */
export const StoredImage = ({
  value,
  alt,
  className,
  loading
}: {
  value?: string | null;
  alt: string;
  className?: string;
  loading?: 'eager' | 'lazy';
}) => {
  const [resolved, setResolved] = useState<{ key: string; url: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!value || !isStoredImageKey(value)) return;
    resolveStoredImageUrl(value)
      .then(url => {
        if (!cancelled && url) setResolved({ key: value, url });
      })
      .catch(error => {
        console.warn('[Images] Could not resolve stored image:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [value]);

  const src = !value ? EMPTY_PIXEL : !isStoredImageKey(value) ? value
    : resolved?.key === value ? resolved.url : EMPTY_PIXEL;
  return <img src={src} alt={alt} className={className} loading={loading} />;
};
