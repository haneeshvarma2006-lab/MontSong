import type { MetadataRoute } from 'next';

/**
 * Web app manifest.
 *
 * Enough for the site to be installed to a phone's home screen and open
 * without browser chrome, which is how a music library actually gets used.
 */
export default function manifest(): MetadataRoute.Manifest {
  const name = process.env.NEXT_PUBLIC_SITE_NAME ?? 'MontSong';

  return {
    name,
    short_name: name,
    description: 'Songs, ringtones and BGM — play them, take them, keep them.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0b0b0d',
    theme_color: '#0b0b0d',
    orientation: 'portrait-primary',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
