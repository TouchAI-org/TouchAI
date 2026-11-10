import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url)).replaceAll('\\', '/');
const require = createRequire(`${root}/package.json`);
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const { default: vue } = await import(pathToFileURL(require.resolve('@vitejs/plugin-vue')).href);
const { default: tailwind } = await import(
    pathToFileURL(require.resolve('@tailwindcss/vite')).href
);
const { default: icons } = await import(pathToFileURL(require.resolve('unplugin-icons/vite')).href);
const { chromium, expect } = require('@playwright/test');
const result = await build({
    root,
    configFile: false,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [vue(), tailwind(), icons({ compiler: 'vue3' })],
    resolve: {
        alias: Object.fromEntries(
            Object.entries({
                '@': 'src',
                '@components': 'src/components',
                '@composables': 'src/composables',
                '@services': 'src/services',
                '@database': 'src/database',
                '@utils': 'src/utils',
                '@assets': 'src/assets',
                '@styles': 'src/styles',
                '@types': 'src/types',
                '@product-config': 'product.json',
            }).map(([alias, suffix]) => [alias, `${root}/${suffix}`])
        ),
    },
    build: {
        write: false,
        minify: false,
        assetsInlineLimit: 0,
        lib: {
            entry: `${root}/tests/layout/fixtures/conversationAppearance.ts`,
            name: 'ConversationAppearance',
            formats: ['iife'],
        },
    },
});
const output = (Array.isArray(result) ? result[0] : result).output;
const css = output.filter((file) => file.type === 'asset' && file.fileName.endsWith('.css'));
const javascript = output.find((file) => file.type === 'chunk' && file.isEntry).code;
const browser = await chromium.launch({
    channel: process.platform === 'win32' ? 'msedge' : undefined,
    headless: true,
});

async function color(locator, property) {
    return locator.evaluate((element, property) => {
        const context = document.createElement('canvas').getContext('2d');
        const style = getComputedStyle(element);
        context.fillStyle = property.startsWith('--')
            ? style.getPropertyValue(property)
            : style[property];
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    }, property);
}

try {
    for (const width of [420, 750]) {
        await test(`user opens a ${width}px conversation and sees the warm message palette with the existing compaction status`, async () => {
            const page = await browser.newPage({ viewport: { width, height: 420 } });
            try {
                const errors = [];
                page.on('pageerror', (error) => errors.push(error.message));
                await page.route('http://conversation.test/', (route) =>
                    route.fulfill({ contentType: 'text/html', body: '<div id="app"></div>' })
                );
                await page.goto('http://conversation.test/');
                await page.evaluate(() => {
                    window.__TAURI_INTERNALS__ = {
                        metadata: {
                            currentWindow: { label: 'main' },
                            currentWebview: { label: 'main' },
                        },
                        invoke: async () => null,
                        transformCallback: () => 0,
                    };
                });
                for (const file of css) await page.addStyleTag({ content: file.source });
                await page.addScriptTag({ content: javascript });
                assert.deepEqual(errors, [], 'The real conversation fixture must mount');
                const text = page.getByText('Inspect the document', { exact: true });
                await text.waitFor();
                const bubble = page.locator('#message > div > div').first();
                const palette = page.locator('html');
                assert.deepEqual(await color(bubble, 'backgroundColor'), [235, 231, 227]);
                assert.deepEqual(
                    await color(text, 'color'),
                    await color(palette, '--color-gray-900')
                );
                const attachment = page.getByText('Report.pdf', { exact: true });
                assert.deepEqual(
                    await color(attachment.locator('..'), 'backgroundColor'),
                    [255, 255, 255]
                );
                assert.deepEqual(
                    await color(attachment, 'color'),
                    await color(palette, '--color-gray-700')
                );
                const copy = page.locator('#message button');
                assert.deepEqual(
                    await color(copy, 'color'),
                    await color(palette, '--color-gray-400')
                );
                await copy.hover();
                await expect
                    .poll(() => color(copy, 'backgroundColor'))
                    .toEqual(await color(palette, '--color-gray-100'));
                await expect
                    .poll(() => color(copy, 'color'))
                    .toEqual(await color(palette, '--color-gray-600'));
                const pin = page.locator('#toolbar button').last();
                await pin.click();
                await page.mouse.move(0, 410);
                assert.equal(await pin.getAttribute('aria-pressed'), 'true');
                await expect.poll(() => color(pin, 'color')).toEqual([90, 79, 69]);
                assert.notEqual(
                    await pin.evaluate((element) => getComputedStyle(element).boxShadow),
                    'none'
                );

                const status = page.locator('#compaction > div');
                const before = await status.boundingBox();
                assert.equal(await status.getAttribute('aria-live'), 'off');
                assert.equal(
                    await status.locator('.t-text-shimmer').textContent(),
                    'Compacting context'
                );
                assert.deepEqual(await color(status, 'color'), [115, 115, 115]);
                const icon = await status.locator('svg').innerHTML();
                await page.locator('#complete').click();
                assert.equal(await status.textContent(), 'Context compacted');
                assert.equal(await status.locator('svg').innerHTML(), icon);
                assert.equal((await status.boundingBox()).height, before.height);
                if (process.env.TOUCHAI_LAYOUT_OUTPUT) {
                    await page.screenshot({
                        path: `${process.env.TOUCHAI_LAYOUT_OUTPUT}/conversation-${width}.png`,
                    });
                }
            } finally {
                await page.close();
            }
        });
    }
} finally {
    await browser.close();
}
