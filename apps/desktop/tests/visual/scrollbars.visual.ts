import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const scrollbarStyles = fileURLToPath(new URL('../../src/styles/scrollbars.css', import.meta.url));

/** Token files are Tailwind v4 `@theme` sources, so the browser needs resolved roles. */
const scrollbarRoles = `:root {
    --color-scrollbar-thumb: rgba(156, 163, 175, 0.25);
    --color-scrollbar-thumb-hover: rgba(156, 163, 175, 0.4);
    --radius-control: 4px;
}`;

async function openScrollport(page: import('@playwright/test').Page) {
    await page.setContent(`
        <section id="viewport" style="block-size:160px;overflow:auto">
            <div style="block-size:900px">Content</div>
        </section>
        <section id="thin" class="custom-scrollbar-thin" style="block-size:160px;overflow:auto">
            <div style="block-size:900px">Content</div>
        </section>
    `);
    await page.addStyleTag({ content: scrollbarRoles });
    await page.addStyleTag({ path: scrollbarStyles });
}

/** Real Chromium layout proves the paint policy; jsdom cannot render scrollbars. */
test('user sees no thumb before scrolling and the semantic thumb while scrolling', async ({
    page,
}) => {
    await openScrollport(page);

    const idle = await page.evaluate(() => {
        const viewport = document.getElementById('viewport')!;
        return getComputedStyle(viewport).getPropertyValue('--scrollbar-thumb-color').trim();
    });
    expect(['transparent', 'rgba(0, 0, 0, 0)']).toContain(idle);

    const active = await page.evaluate(() => {
        const viewport = document.getElementById('viewport')!;
        viewport.setAttribute('data-scrollbar-scrolling', '');
        return getComputedStyle(viewport).getPropertyValue('--scrollbar-thumb-color').trim();
    });
    expect(active).toBe('rgba(156, 163, 175, 0.25)');

    const hover = await page.evaluate(() => {
        const viewport = document.getElementById('viewport')!;
        return getComputedStyle(viewport).getPropertyValue('--scrollbar-thumb-hover-color').trim();
    });
    expect(hover).toBe('rgba(156, 163, 175, 0.4)');
});

test('user scrolling a page sees no layout shift when the thumb appears', async ({ page }) => {
    await openScrollport(page);

    const measure = () =>
        page.evaluate(() => {
            const viewport = document.getElementById('viewport')!;
            return {
                clientWidth: viewport.clientWidth,
                scrollWidth: viewport.scrollWidth,
                gutter: viewport.scrollWidth - viewport.clientWidth,
                scrollbarWidth: getComputedStyle(viewport).scrollbarWidth,
            };
        });

    const before = await measure();
    await page.evaluate(() =>
        document.getElementById('viewport')!.setAttribute('data-scrollbar-scrolling', '')
    );
    await page.waitForTimeout(50);
    const after = await measure();

    expect(after).toEqual(before);
    expect(before.scrollbarWidth).toBe('auto');

    const thin = await page.evaluate(() => {
        const element = document.getElementById('thin')!;
        return {
            scrollbarWidth: getComputedStyle(element).scrollbarWidth,
            gutter: element.scrollWidth - element.clientWidth,
        };
    });
    expect(thin.scrollbarWidth).toBe('auto');
});
