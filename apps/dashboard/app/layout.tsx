/** Root layout: IBM Plex Sans and the design tokens. Owned by: dash-shell. */
import type { Metadata } from 'next';
import { IBM_Plex_Sans, Instrument_Sans } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const plex = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex',
  display: 'swap',
});

// The wordmark only (design/brand). Everything else stays IBM Plex Sans (UI.md).
const brand = Instrument_Sans({
  subsets: ['latin'],
  weight: ['500'],
  variable: '--font-instrument',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'PacePay',
  description: 'Every account, 60 days ahead, with an agent that fixes the problem.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${plex.variable} ${brand.variable}`}>
      <body>{children}</body>
    </html>
  );
}
