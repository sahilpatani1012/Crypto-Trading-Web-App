import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // The protocol package ships TypeScript source (D-001), so it must be bundled
  // rather than left as a runtime import Node cannot resolve.
  noExternal: ['@cta/protocol'],
});
