import type { Metadata, Viewport } from 'next';

import { MiniPlayer } from '@/components/player/MiniPlayer';
import { SiteHeader } from '@/components/SiteHeader';
import { getSiteCopy, siteUrl } from '@/lib/site';

import './globals.css';

/**
 * Root layout.
 *
 * The header, footer and player live here so the player element survives every
 * client-side navigation — a track keeps playing while the listener browses,
 * which is the single biggest difference between a music site and a page with
 * audio on it.
 */

export async function generateMetadata(): Promise<Metadata> {
  const copy = await getSiteCopy();

  return {
    metadataBase: new URL(siteUrl()),
    title: {
      default: `${copy.name} — songs, ringtones & BGM`,
      template: `%s · ${copy.name}`,
    },
    description: copy.tagline,
    applicationName: copy.name,
    alternates: { canonical: '/' },
    openGraph: {
      type: 'website',
      siteName: copy.name,
      title: `${copy.name} — songs, ringtones & BGM`,
      description: copy.tagline,
      url: siteUrl(),
    },
    twitter: {
      card: 'summary_large_image',
      title: `${copy.name} — songs, ringtones & BGM`,
      description: copy.tagline,
    },
    robots: { index: true, follow: true },
    formatDetection: { telephone: false, address: false, email: false },
  };
}

export const viewport: Viewport = {
  themeColor: '#0b0b0d',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  // Zooming is an accessibility feature, not a layout inconvenience.
  maximumScale: 5,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const copy = await getSiteCopy();

  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>

        <SiteHeader siteName={copy.name} />

        <main id="main">{children}</main>

        <footer className="footer">
          <div className="page footer__inner">
            <p>
              {copy.name} · {copy.about}
            </p>
            <p>Made for listening.</p>
          </div>
        </footer>

        <MiniPlayer />
      </body>
    </html>
  );
}
