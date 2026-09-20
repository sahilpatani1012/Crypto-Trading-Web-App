import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// `new URL(...).pathname` is wrong here: on Windows it yields a leading-slash,
// percent-encoded path ("/C:/.../Crypto%20Trading%20Web%20App"), which Next cannot
// canonicalize. fileURLToPath is the correct conversion on every platform.
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * The protocol package ships TypeScript source rather than a build artifact
   * (D-001), so Next must compile it as part of this app rather than treating it
   * as a prebuilt node_module.
   */
  transpilePackages: ['@cta/protocol'],

  /**
   * Vercel builds this app from within a workspace, so file tracing has to be
   * rooted at the repo rather than at apps/web, or the traced bundle would miss
   * the hoisted node_modules and the protocol source.
   */
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
