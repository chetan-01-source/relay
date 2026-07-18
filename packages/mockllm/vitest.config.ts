import { defineConfig } from 'vitest/config';

// Zero the artificial latency so the mock's own tests run fast.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    env: { MOCKLLM_LATENCY_MS: '0' },
  },
});
