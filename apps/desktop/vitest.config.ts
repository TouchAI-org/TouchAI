import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import Icons from 'unplugin-icons/vite'
import { defineConfig } from 'vitest/config'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [vue(), tailwindcss(), Icons()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.{ts,js}'],
    exclude: ['node_modules', 'dist', '.idea', '.git', '.cache'],
    setupFiles: ['./tests/setup/vitest.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary', 'lcov'],
      reportsDirectory: './.coverage/unit',
      include: ['src/**/*.{ts,vue}'],
      exclude: [
        'src/**/*.d.ts',
        'src/main.ts',
        'src/router/**',
        'src/assets/**',
        'src/styles/**',
        'src/**/index.vue',
        'src/components/appIconMap.ts',
      ],
      thresholds: {
        'src/services/EventService/**/*.ts': {
          statements: 90,
          branches: 100,
          functions: 100,
          lines: 90,
        },
        'src/services/NativeService/**/*.ts': {
          statements: 90,
          branches: 80,
          functions: 90,
          lines: 90,
        },
        'src/views/SearchView/components/QuickSearchPanel/composables/**/*.ts': {
          statements: 75,
          branches: 65,
          functions: 75,
          lines: 80,
        },
        'src/views/SearchView/components/QuickSearchPanel/utils/**/*.ts': {
          statements: 95,
          branches: 60,
          functions: 100,
          lines: 95,
        },
        'src/views/SearchView/components/SearchBar/composables/**/*.ts': {
          statements: 70,
          branches: 50,
          functions: 75,
          lines: 72,
        },
        'src/views/SearchView/composables/interaction/useSearchKeyboardRouter.ts': {
          statements: 85,
          branches: 75,
          functions: 85,
          lines: 85,
        },
        'src/views/SearchView/composables/useSearchInput.ts': {
          statements: 90,
          branches: 75,
          functions: 100,
          lines: 90,
        },
        'src/views/SearchView/composables/useSearchRequest.ts': {
          statements: 60,
          branches: 45,
          functions: 50,
          lines: 60,
        },
        'src/views/SearchView/utils/clipboardDraft.ts': {
          statements: 95,
          branches: 75,
          functions: 100,
          lines: 95,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@components': resolve(__dirname, './src/components'),
      '@assets': resolve(__dirname, './src/assets'),
      '@composables': resolve(__dirname, './src/composables'),
      '@services': resolve(__dirname, './src/services'),
      '@database': resolve(__dirname, './src/database'),
      '@utils': resolve(__dirname, './src/utils'),
      '@types': resolve(__dirname, './src/types'),
      '@styles': resolve(__dirname, './src/styles'),
      '@tests': resolve(__dirname, './tests'),
    },
  },
  optimizeDeps: {
    include: ['parse5']
  }
})
