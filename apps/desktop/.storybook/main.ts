/**
 * Storybook configuration for component-level visual tests.
 *
 * The end-to-end suite can only show screens it can reach with real data: launch
 * the app, open settings, navigate. That leaves most component states unrendered —
 * a button in every variant, a switch off and on, an empty table, a populated
 * chart. Those states are where token drift usually lands, and they are cheap to
 * render in isolation.
 *
 * The same `tailwind.css` the app imports is loaded here, so stories resolve the
 * real tokens rather than a copy. Anything that depends on Tauri APIs is stubbed
 * by `.storybook/preview.ts`, because a story should not need a Rust backend.
 */
import { fileURLToPath } from 'node:url';

import type { StorybookConfig } from '@storybook/vue3-vite';

import productFontPlugin from './product-font-plugin.js';

const config: StorybookConfig = {
    stories: ['../src/**/*.stories.@(ts|js)'],
    addons: [],
    framework: {
        name: '@storybook/vue3-vite',
        options: {
            docgen: false,
        },
    },
    async viteFinal(viteConfig) {
        viteConfig.resolve ??= {};
        viteConfig.resolve.alias = {
            ...viteConfig.resolve.alias,
            '@': fileURLToPath(new URL('../src', import.meta.url)),
            '@components': fileURLToPath(new URL('../src/components', import.meta.url)),
            '@assets': fileURLToPath(new URL('../src/assets', import.meta.url)),
            '@utils': fileURLToPath(new URL('../src/utils', import.meta.url)),
            '@types': fileURLToPath(new URL('../src/types', import.meta.url)),
            '@styles': fileURLToPath(new URL('../src/styles', import.meta.url)),
            '@services': fileURLToPath(new URL('../src/services', import.meta.url)),
            '@composables': fileURLToPath(new URL('../src/composables', import.meta.url)),
            '@database': fileURLToPath(new URL('../src/database', import.meta.url)),
        };
        viteConfig.plugins ??= [];
        viteConfig.plugins.push(productFontPlugin());

        return viteConfig;
    },
};

export default config;
