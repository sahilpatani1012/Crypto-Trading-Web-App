import { defineConfig } from 'vitest/config';

/**
 * One runner across the whole workspace.
 *
 * Tests live next to the code they cover, because a reviewer looking at
 * `TierController.ts` should see `TierController.test.ts` beside it rather than
 * hunting through a mirrored tree.
 */
export default defineConfig({
  test: {
    include: ['apps/**/src/**/*.test.ts', 'packages/**/src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // The tier state machine and the delivery scheduler are timer-driven. Every
    // test that touches them uses fake timers rather than real sleeps, so the
    // suite stays deterministic and finishes in milliseconds.
    clearMocks: true,
    restoreMocks: true,
  },
});
