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
/**
 * The stroke and rim values come from the stylesheet, not from a copy in this
 * script: changing a token must move this check, never silently pass it.
 */
function colorToken(name) {
    const declared = new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();
    assert.ok(declared, `Missing colour token --${name} in the built stylesheet`);

    // The production build folds `rgb(74 64 57 / 0.28)` into `#4a403947`.
    const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(declared);
    if (hex) {
        const value = hex[1];
        return {
            rgb: [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16)),
            alpha: hex[2] ? parseInt(hex[2], 16) / 255 : 1,
        };
    }

    const rgbPattern = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/;
    const rgb = rgbPattern.exec(declared);
    assert.ok(rgb, `Unsupported colour token --${name}: ${declared}`);
    return { rgb: rgb.slice(1, 4).map(Number), alpha: rgb[4] ? Number(rgb[4]) : 1 };
}

const strokeToken = colorToken('color-window-stroke');
const rimToken = colorToken('color-window-rim-highlight');

function blend(layer, content) {
    return layer.rgb.map((value, index) =>
        Math.round(value * layer.alpha + content[index] * (1 - layer.alpha))
    );
}

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
            await test(`user sees one warm stroke with a light rim when Settings opens at ${size} size with ${surface} content`, async () => {
                const page = await browser.newPage({ viewport: { width, height } });
                try {
                    await page.setContent(`<style>${css}</style>
                    <div class="${frameClass}"><div class="${shellClass}" data-shell style="background:${background}">
                        <button aria-label="Content" style="display:block;width:100%;height:100%;border:0;background:${background};outline:none"></button>
                    </div></div>`);
                    const [gutter, edge, rim, content] = await pixels(page, [
                        [0, Math.floor(height / 2)],
                        [Math.floor(width / 2), 24],
                        [Math.floor(width / 2), 25],
                        [Math.floor(width / 2), 26],
                    ]);
                    assert.equal(gutter[3], 0, 'The shadow gutter must have no surface border');
                    // 描边是半透明的，光边在它下面 1px 处透出来，所以边缘像素是
                    // 「描边叠在光边上」，光边本身在它内侧一行。
                    const expectedEdge = blend(strokeToken, blend(rimToken, content));
                    const expectedRim = blend(rimToken, content);
                    for (const channel of [0, 1, 2]) {
                        assert.ok(
                            Math.abs(edge[channel] - expectedEdge[channel]) <= 1,
                            `The warm stroke must blend once over opaque content: ${edge} vs ${expectedEdge}`
                        );
                        assert.ok(
                            Math.abs(rim[channel] - expectedRim[channel]) <= 1,
                            `The light rim must be drawn once inside the stroke: ${rim} vs ${expectedRim}`
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
                    const [uncoveredEdge, uncoveredRim] = await pixels(page, [
                        [Math.floor(width / 2), 24],
                        [Math.floor(width / 2), 25],
                    ]);
                    assert.deepEqual(uncoveredEdge, edge, 'The border must not be painted twice');
                    assert.deepEqual(uncoveredRim, rim, 'The rim must not be painted twice');
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
        await test(`user sees the same warm stroke when opaque ${surface} content fills the search card`, async () => {
            const page = await browser.newPage({ viewport: { width: 1168, height: 748 } });
            try {
                await page.setContent(`<style>${css}</style>
                <div class="${frameClass}"><div class="search-view-surface-card search-surface-elevated relative overflow-hidden border-0" style="width:100%;height:100%;background:${background}">
                    <div style="position:absolute;inset:0;background:${background}"></div>
                </div></div>`);
                const [edge, content] = await pixels(page, [
                    [584, 24],
                    [584, 26],
                ]);
                const expectedEdge = blend(strokeToken, content);
                for (const channel of [0, 1, 2]) {
                    assert.ok(
                        Math.abs(edge[channel] - expectedEdge[channel]) <= 1,
                        `The search border must blend once over opaque content: ${edge} vs ${expectedEdge}`
                    );
                }
                const stroke = await page.locator('.search-view-surface-card').evaluate((card) => ({
                    width: getComputedStyle(card).borderWidth,
                    pointerEvents: getComputedStyle(card, '::after').pointerEvents,
                }));
                assert.deepEqual(stroke, { width: '0px', pointerEvents: 'none' });
            } finally {
                await page.close();
            }
        });
    }
} finally {
    await browser.close();
}
