/**
 * Where the backend lives.
 *
 * `NEXT_PUBLIC_` is required for these to reach the browser: Next inlines those at
 * build time and strips everything else, so a plain `API_URL` would be `undefined`
 * in client code. That also means changing them requires a rebuild, not just a
 * restart — which is exactly why the deployed frontend has to be rebuilt after the
 * backend's URL is known.
 *
 * The localhost fallbacks keep `npm run dev` working with no .env file at all.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws';

/**
 * A page served over HTTPS may not open a `ws://` socket — browsers block it as
 * mixed content, and the failure is silent enough to waste an afternoon. Catching
 * the misconfiguration here turns it into an obvious console error instead.
 */
export function assertSecureTransport(): void {
  if (typeof window === 'undefined') return;
  if (window.location.protocol === 'https:' && WS_URL.startsWith('ws://')) {
    console.error(
      `[config] NEXT_PUBLIC_WS_URL is "${WS_URL}" but the page is HTTPS. ` +
        'Browsers block insecure WebSockets from secure pages — use wss://.',
    );
  }
}
