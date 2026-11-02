import { defineConfig } from 'vitest/config'

import baseConfig from './vitest.config'

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    coverage: {
      ...baseConfig.test?.coverage,
      thresholds: undefined,
      reporter: [],
    },
  },
})
