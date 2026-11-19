import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import Icons from 'unplugin-icons/vite';
import { defineConfig } from 'vitest/config';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    root: __dirname,
    plugins: [vue(), tailwindcss(), Icons()],
    test: {
        environment: 'jsdom',
        // This stylesheet is passed as text into the code renderer's Shadow DOM.
        css: { include: [/markdown-code-surface\.css/] },
        globals: true,
        projects: [
            {
                extends: true,
                test: {
                    name: 'desktop',
                    environment: 'jsdom',
                    include: ['tests/**/*.test.{ts,js}'],
                    setupFiles: ['./tests/setup/vitest.ts'],
                },
            },
            {
                extends: true,
                test: {
                    name: 'business-packages',
                    environment: 'node',
                    include: ['../../packages/*/tests/**/*.test.ts'],
                    setupFiles: [],
                },
            },
        ],
        exclude: ['node_modules', 'dist', '.idea', '.git', '.cache'],
        coverage: {
            provider: 'v8',
            // `json` feeds the patch-coverage gate (the lines this change touched); the others
            // feed the step summary, the uploaded artifact and local browsing.
            reporter: ['text', 'html', 'json-summary', 'json', 'lcov'],
            reportsDirectory: './.coverage/unit',
            include: ['src/**/*.{ts,vue}', '../../packages/*/src/**/*.ts'],
            allowExternal: true,
            exclude: [
                'src/**/*.d.ts',
                'src/main.ts',
                'src/router/**',
                'src/assets/**',
                'src/styles/**',
                'src/**/index.vue',
                'src/components/appIconMap.ts',
                // Storybook stories are fixtures for the component visual layer, not product
                // code. Nothing imports them at runtime, so counting them would only measure
                // the absence of unit tests for files that exist to be screenshotted.
                'src/**/*.stories.ts',
            ],
            thresholds: {
                // Global floor. It stops a change from quietly trading covered behavior for
                // uncovered code; it is a regression guard, not a target to game.
                // These keys must stay at the top level: vitest reads the global floor from
                // thresholds.<metric> and treats a nested "global" object as a glob pattern
                // that matches no file, which would leave the gate silently inert.
                //
                // The floor only moves up. Run `pnpm test:coverage:raise` after a change that
                // genuinely raises coverage; it uses vitest's own thresholds.autoUpdate, which
                // rewrites a number only when the measured value exceeds it, so a metric can never
                // be lowered this way and a drop below the committed value fails CI.
                // See docs/testing/testing.md.
                statements: 90,
                branches: 84,
                functions: 88,
                lines: 91,
                'src/platform/windows/events.ts': {
                    statements: 90,
                    branches: 100,
                    functions: 100,
                    lines: 90,
                },
                'src/app/api/windows/eventContracts.ts': {
                    statements: 90,
                    branches: 100,
                    functions: 100,
                    lines: 90,
                },
                'src/platform/native/**/*.ts': {
                    statements: 90,
                    branches: 80,
                    functions: 90,
                    lines: 90,
                },
                'src/modules/tools/builtin/browser/**/*.ts': {
                    statements: 90,
                    branches: 90,
                    functions: 90,
                    lines: 90,
                },
                'src/views/SettingsView/components/BuiltInTools/browserToolGroup.ts': {
                    statements: 90,
                    branches: 90,
                    functions: 90,
                    lines: 90,
                },
                'src/views/SearchView/components/QuickSearchPanel/composables/**/*.ts': {
                    statements: 75,
                    branches: 65,
                    functions: 75,
                    lines: 80,
                },
                'src/utils/searchHighlight.ts': {
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
            '@product-config': resolve(__dirname, './product.json'),
            '@': resolve(__dirname, './src'),
            '@components': resolve(__dirname, './src/components'),
            '@assets': resolve(__dirname, './src/assets'),
            '@composables': resolve(__dirname, './src/composables'),
            '@database': resolve(__dirname, './src/database'),
            '@utils': resolve(__dirname, './src/utils'),
            '@types': resolve(__dirname, './src/types'),
            '@styles': resolve(__dirname, './src/styles'),
            '@tests': resolve(__dirname, './tests'),
        },
    },
    optimizeDeps: {
        include: ['parse5'],
    },
});
