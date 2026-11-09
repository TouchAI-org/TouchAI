import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url)).replaceAll('\\', '/');
const require = createRequire(`${root}/package.json`);
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const { default: tailwindcss } = await import(
    pathToFileURL(require.resolve('@tailwindcss/vite')).href
);
const { chromium } = require('@playwright/test');
const view = await readFile(`${root}/src/views/SettingsView/index.vue`, 'utf8');
const frameClass = view.match(/class="([^"]+)"\s+data-testid="settings-view"/)[1];
const shellClass = view.match(/class="([^"]+)"\s+data-testid="settings-window-shell"/)[1];
const result = await build({
    root,
    configFile: false,
    logLevel: 'warn',
    plugins: [tailwindcss()],
    build: {
        write: false,
        minify: false,
        cssCodeSplit: true,
        lib: {
            entry: `${root}/src/styles/tailwind.css`,
            name: 'SettingsChrome',
            formats: ['es'],
        },
    },
});
const output = (Array.isArray(result) ? result[0] : result).output;
const css = output
    .filter((file) => file.type === 'asset' && file.fileName.endsWith('.css'))
    .map((file) => file.source)
    .join('\n');
const browser = await chromium.launch({
    channel: process.platform === 'win32' ? 'msedge' : undefined,
    headless: true,
});

/**
 * Computed shadow styles cannot prove that opaque children leave the stroke visible;
 * sample the rendered screenshot instead.
 */
async function pixels(page, points) {
    const screenshot = await page.screenshot({ omitBackground: true });
    return page.evaluate(
        async ({ imageData, samplePoints }) => {
            const image = new Image();
            image.src = `data:image/png;base64,${imageData}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            return samplePoints.map(([left, top]) =>
                Array.from(context.getImageData(left, top, 1, 1).data)
            );
        },
        { imageData: screenshot.toString('base64'), samplePoints: points }
    );
}

try {
    for (const [surface, background] of [
        ['light', 'var(--color-canvas-sunken)'],
        ['dark', 'rgb(21 21 21)'],
    ]) {
        for (const [size, width, height] of [
            ['default', 1168, 748],
            ['minimum', 968, 608],
        ]) {
            await test(`user sees one native gray border when Settings opens at ${size} size with ${surface} content`, async () => {
                const page = await browser.newPage({ viewport: { width, height } });
                try {
                    await page.setContent(`<style>${css}</style>
                    <div class="${frameClass}"><div class="${shellClass}" data-shell style="background:${background}">
                        <button aria-label="Content" style="display:block;width:100%;height:100%;border:0;background:${background};outline:none"></button>
                    </div></div>`);
                    const [gutter, edge, content] = await pixels(page, [
                        [0, Math.floor(height / 2)],
                        [Math.floor(width / 2), 24],
                        [Math.floor(width / 2), 26],
                    ]);
                    assert.equal(gutter[3], 0, 'The shadow gutter must have no surface border');
                    for (const channel of [0, 1, 2]) {
                        const expected = 169;
                        assert.ok(
                            Math.abs(edge[channel] - expected) <= 1,
                            `Opaque content must not change or hide the native neutral gray border: ${edge} vs ${content}`
                        );
                    }
                    if (process.env.TOUCHAI_LAYOUT_OUTPUT) {
                        await page.screenshot({
                            path: `${process.env.TOUCHAI_LAYOUT_OUTPUT}/settings-stroke-${size}-${surface}.png`,
                            omitBackground: true,
                        });
                    }
                    await page.evaluate(() => {
                        window.contentClicks = 0;
                        document.querySelector('button').onclick = () => window.contentClicks++;
                    });
                    await page.mouse.click(Math.floor(width / 2), 24);
                    assert.equal(await page.evaluate(() => window.contentClicks), 1);
                    await page.evaluate(() => {
                        document.querySelector('button').style.background = 'transparent';
                    });
                    const [uncoveredEdge] = await pixels(page, [[Math.floor(width / 2), 24]]);
                    assert.deepEqual(uncoveredEdge, edge, 'The border must not be painted twice');
                    await page.evaluate(() => {
                        document.documentElement.dataset.windowMaximized = 'true';
                    });
                    const [maximizedEdge, maximizedContent] = await pixels(page, [
                        [Math.floor(width / 2), 0],
                        [Math.floor(width / 2), 2],
                    ]);
                    assert.deepEqual(maximizedEdge, maximizedContent);
                    const chrome = await page.locator('[data-shell]').evaluate((shell) => ({
                        radius: getComputedStyle(shell).borderRadius,
                        shadow: getComputedStyle(shell).boxShadow,
                        stroke: getComputedStyle(shell, '::after').boxShadow,
                    }));
                    assert.deepEqual(chrome, { radius: '0px', shadow: 'none', stroke: 'none' });
                } finally {
                    await page.close();
                }
            });
        }
        await test(`user sees the same native gray border when search paints ${surface} content`, async () => {
            const page = await browser.newPage({ viewport: { width: 1168, height: 748 } });
            try {
                await page.setContent(`<style>${css}</style>
                <div class="${frameClass}"><div class="search-surface-elevated" style="width:100%;height:100%;background:${background}"></div></div>`);
                const [edge] = await pixels(page, [[584, 24]]);
                for (const channel of [0, 1, 2]) {
                    assert.ok(
                        Math.abs(edge[channel] - 169) <= 1,
                        `The search border must match the native neutral gray: ${edge}`
                    );
                }
            } finally {
                await page.close();
            }
        });
    }
} finally {
    await browser.close();
}
