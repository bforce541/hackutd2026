/** Root layout: Instrument Sans + DM Mono, the design tokens, and the theme set before first paint. Owned by: dash-shell. */
import type { Metadata } from 'next';
import { DM_Mono, Instrument_Sans } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

// One family for display and UI (it is also the wordmark), one mono for the small uppercase labels.
const sans = Instrument_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-instrument',
  display: 'swap',
});

const mono = DM_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-dm-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'PacePay',
  description: 'Every account, 60 days ahead, with an agent that fixes the problem.',
};

/**
 * Runs while the HTML is parsed, before the first paint, so a saved Night choice never flashes
 * Light (Next: "Preventing flash before hydration"). Storage can throw in private windows.
 */
const THEME_SCRIPT = `try{var t=localStorage.getItem('pacepay-theme');if(t==='night'||t==='light')document.documentElement.dataset.theme=t}catch(e){}`;

function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
      <head>
        <InlineScript html={THEME_SCRIPT} />
      </head>
      <body>{children}</body>
    </html>
  );
}
