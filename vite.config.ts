import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import monacoEditorEsmPlugin from 'vite-plugin-monaco-editor-esm'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [
    monacoEditorEsmPlugin({
      languageWorkers: ['editorWorkerService'],
    }),
    tailwindcss(),
    vue(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@assets': resolve(__dirname, './src/assets'),
      '@components': resolve(__dirname, './src/components'),
      '@composables': resolve(__dirname, './src/composables'),
      '@database': resolve(__dirname, './src/database'),
      '@services': resolve(__dirname, './src/services'),
      '@styles': resolve(__dirname, './src/styles'),
      '@types': resolve(__dirname, './src/types'),
      '@utils': resolve(__dirname, './src/utils'),
    },
  },
  build: {
    target: ['chrome105'],
    modulePreload: {
      polyfill: false,
    },
    cssCodeSplit: true,
    assetsInlineLimit: 8192,
    reportCompressedSize: false,
    minify: 'terser',
    terserOptions: {
      maxWorkers: 1,
      compress: {
        drop_debugger: true,
        passes: 2,
      },
      format: {
        comments: false,
      },
    },
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-framework': ['vue', 'vue-router', 'pinia'],
          'vendor-ui': ['reka-ui', 'vue-sonner'],
          'vendor-ai': ['openai', '@anthropic-ai/sdk'],
          'vendor-markdown': ['markstream-vue', 'markdown-it-emoji'],
          'vendor-diagrams': ['mermaid', 'katex'],
          'vendor-monaco': ['monaco-editor'],
          'vendor-tauri': [
            '@tauri-apps/api',
            '@tauri-apps/plugin-dialog',
            '@tauri-apps/plugin-fs',
            '@tauri-apps/plugin-http',
            '@tauri-apps/plugin-notification',
            '@tauri-apps/plugin-opener',
            '@tauri-apps/plugin-process',
            '@tauri-apps/plugin-sql',
          ],
        },
      },
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**', '**/data/**'],
    },
  },
})
