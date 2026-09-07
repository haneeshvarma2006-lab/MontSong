'use client';

import { useState } from 'react';

/**
 * Cover artwork with a fallback.
 *
 * Artwork can fail to load for reasons that have nothing to do with a bug: the
 * stored file was removed from the channel by hand, the storage service is
 * having a moment, the connection dropped mid-image. The browser's default
 * response to that is a broken-image icon, which looks like the site is broken.
 *
 * So a failed load falls back to the same plate a track with no artwork gets.
 * A client component for one reason — `onError` needs a listener — and it stays
 * as small as that requires.
 */
export function CoverArt({
  src,
  size = 240,
  className = 'song__art',
  eager = false,
}: {
  src: string | null;
  size?: number;
  className?: string;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div className={className}>
        <span className="song__art-placeholder" aria-hidden="true">
          ♪
        </span>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={src}
      alt=""
      width={size}
      height={size}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
