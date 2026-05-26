import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import Icons from 'unplugin-icons/vite'
import { defineConfig } from 'vite'
import monacoEditorEsmPlugin from 'vite-plugin-monaco-editor-esm'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const host = process.env.TAURI_DEV_HOST

const escapeRegExp = (value: string) => value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')

const createNodeModulesGroup = (
  chunkName: string,
  packagePatterns: readonly string[],
  priority: number,
) => {
  const matcher = new RegExp(
    `node_modules[\\\\/](?:${packagePatterns.map(escapeRegExp).join('|')})(?:[\\\\/]|$)`,
  )

  return {
    priority,
    name(moduleId: string) {
      return matcher.test(moduleId) ? chunkName : null
    },
  }
}

const chunkGroups = [
  createNodeModulesGroup('vendor-framework', ['vue', 'vue-router', 'pinia'], 70),
  createNodeModulesGroup('vendor-ui', ['reka-ui', 'vue-sonner'], 60),
  createNodeModulesGroup(
    'vendor-ai',
    [
      'ai',
      '@ai-sdk/openai',
      '@ai-sdk/anthropic',
      '@ai-sdk/google',
      '@ai-sdk/deepseek',
      '@ai-sdk/moonshotai',
      '@ai-sdk/alibaba',
      '@ai-sdk/xai',
      'vercel-minimax-ai-provider',
      'zhipu-ai-provider',
    ],
    50,
  ),
  createNodeModulesGroup('vendor-markdown', ['markstream-vue', 'markdown-it-emoji'], 40),
  createNodeModulesGroup('vendor-diagrams', ['mermaid', 'katex'], 30),
  createNodeModulesGroup('vendor-monaco', ['monaco-editor'], 20),
  createNodeModulesGroup(
    'vendor-tauri',
    [
      '@tauri-apps/api',
      '@tauri-apps/plugin-dialog',
      '@tauri-apps/plugin-fs',
      '@tauri-apps/plugin-http',
      '@tauri-apps/plugin-notification',
      '@tauri-apps/plugin-opener',
      '@tauri-apps/plugin-process',
      '@tauri-apps/plugin-sql',
    ],
    10,
  ),
] as const

export default defineConfig({
  plugins: [
    monacoEditorEsmPlugin({
      languageWorkers: [],
      customWorkers: [
        {
          label: 'editorWorkerService',
          entry: 'monaco-editor/esm/vs/editor/editor.worker.js',
        },
      ],
    }),
    Icons({
      compiler: 'vue3',
    }),
    tailwindcss(),
    vue(),
  ],
  resolve: {
    alias: {
      // vue-draggable-plus 0.6.1 的 ESM bundle 会被当前 Rolldown RC 错误 tree-shake，
      // 运行时改走该包自带 CJS 入口，保留拖拽功能并避开 Bt_mounted 未定义问题。
      'vue-draggable-plus': resolve(
        __dirname,
        './node_modules/vue-draggable-plus/dist/vue-draggable-plus.cjs',
      ),
      '@product-config': resolve(__dirname, './product.json'),
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
    cssMinify: 'esbuild',
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
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: chunkGroups,
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
