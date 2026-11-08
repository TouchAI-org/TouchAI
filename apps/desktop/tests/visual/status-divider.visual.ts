import { expect, test } from '@playwright/test';

test('user sees compaction shimmer with higher contrast and static text with reduced motion', async ({
    page,
}, testInfo) => {
    await page.emulateMedia({ contrast: 'more', reducedMotion: 'no-preference' });
    await page.goto('/iframe.html?id=primitives-statusdivider--chinese-loading&viewMode=story');
    await page.waitForSelector('#storybook-root > *', { state: 'attached' });
    const label = page.getByText('正在压缩上下文', { exact: true });
    await expect(label).toBeVisible();
    await page.evaluate(async () => {
        await document.fonts.ready;
    });

    for (const width of [420, 750]) {
        await page.setViewportSize({ width, height: 260 });
        await label.evaluate((element) => {
            for (const animation of element.getAnimations()) {
                animation.pause();
                animation.currentTime = 0;
            }
        });
        const start = await label.screenshot({ animations: 'allow' });
        await label.evaluate((element) => {
            for (const animation of element.getAnimations()) {
                animation.currentTime = Number(animation.effect!.getTiming().duration) / 4;
            }
        });
        const highlighted = await label.screenshot({ animations: 'allow' });
        await testInfo.attach(`high-contrast-start-${width}`, {
            body: start,
            contentType: 'image/png',
        });
        await testInfo.attach(`high-contrast-highlight-${width}`, {
            body: highlighted,
            contentType: 'image/png',
        });
        expect(highlighted.equals(start), 'the loading text must visibly shimmer').toBe(false);
    }

    await page.emulateMedia({ contrast: 'more', reducedMotion: 'reduce' });
    const reduced = await label.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
            animation: style.animationName,
            fill: style.webkitTextFillColor,
            color: style.color,
        };
    });
    expect(reduced.animation).toBe('none');
    expect(reduced.fill).toBe(reduced.color);
    expect(reduced.fill).not.toBe('rgba(0, 0, 0, 0)');
});
