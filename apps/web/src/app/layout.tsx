import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BTC-USD · Adaptive Trading Terminal',
  description:
    'Simulated crypto market with per-connection adaptive chart delivery: full, degraded and minimal tiers driven by measured latency and jitter.',
};

export const viewport: Viewport = {
  themeColor: '#0b0e13',
  width: 'device-width',
  initialScale: 1,
};

/**
 * The root layout is a Server Component and stays one (D-002). Nothing here needs
 * interactivity, so none of it ships JavaScript; the `'use client'` boundary is
 * pushed down to the live trading panel.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
