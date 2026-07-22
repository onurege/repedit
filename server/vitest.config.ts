import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: 'postgres://district:district@localhost:5432/business_district_test',
      DEV_TOOLS: '1',
    },
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
