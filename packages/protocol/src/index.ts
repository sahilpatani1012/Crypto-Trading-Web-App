/**
 * @cta/protocol — the single source of truth for every byte crossing the wire.
 *
 * This package ships TypeScript source rather than a build artifact (D-001): both
 * consumers already have a TypeScript build step (Next.js `transpilePackages` and
 * tsup on the server), so adding a third build would be ceremony that buys nothing.
 */

export * from './config';
export * from './types';
export * from './frames';
export * from './rest';
