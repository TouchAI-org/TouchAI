import { expect, type Page, test } from '@playwright/test';

async function openReply(page: Page, story = 'official-dashboard') {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/iframe.html?id=search-visual-replies--${story}&viewMode=story`);
    await expect(page.getByRole('heading', { name: 'Sales pipeline', exact: true })).toBeVisible();
    return page.getByTestId('openui-reply');
}

test.describe('given a visual reply in a conversation', () => {
    test('user reads the report without tiny labels or an extra enclosing panel', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1120, height: 1000 });
        const reply = await openReply(page);
        const appearance = await reply.locator('.visual-reply-root').evaluate((element) => {
            const style = getComputedStyle(element);
            return {
                textSize: parseFloat(style.fontSize),
                border: style.borderTopWidth,
                background: style.backgroundColor,
                labelSizes: [...element.querySelectorAll('.visual-reply-metric-label, th')].map(
                    (label) => parseFloat(getComputedStyle(label).fontSize)
                ),
            };
        });

        expect(appearance.textSize).toBeGreaterThanOrEqual(14);
        expect(appearance.labelSizes.every((size) => size >= 12)).toBe(true);
        expect(appearance.border).toBe('0px');
        expect(appearance.background).toBe('rgba(0, 0, 0, 0)');
        await expect(reply.getByRole('columnheader', { name: 'Pipeline', exact: true })).toHaveCSS(
            'text-align',
            'end'
        );
        await expect(reply.getByRole('cell', { name: '$1.68M', exact: true })).toHaveCSS(
            'text-align',
            'end'
        );
    });

    test('user sees charts stack when the conversation narrows inside a wide window', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1120, height: 1000 });
        const reply = await openReply(page);
        await reply.evaluate((element) => {
            element.style.width = '360px';
        });

        const bookings = await reply.locator('.visual-reply-column-primary').boundingBox();
        const stages = await reply.locator('.visual-reply-column-secondary').boundingBox();
        expect(bookings).not.toBeNull();
        expect(stages).not.toBeNull();
        expect(stages!.y).toBeGreaterThanOrEqual(bookings!.y + bookings!.height);

        const metrics = reply.locator('.visual-reply-metric');
        const first = await metrics.nth(0).boundingBox();
        const third = await metrics.nth(2).boundingBox();
        expect(third!.y).toBeGreaterThan(first!.y);
        expect(await reply.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
            true
        );
    });

    test('user keeps labels and controls readable on a phone', async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 390, height: 844 });
        const reply = await openReply(page);
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        ).toBe(true);
        const action = reply.getByRole('button', { name: 'Break down pipeline by region' });
        expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(32);
        await expect(reply.getByText('Negotiation', { exact: true })).toBeVisible();
        expect(
            await reply
                .locator('.visual-reply-bar-label')
                .evaluateAll((labels) =>
                    labels.every((label) => label.scrollWidth <= label.clientWidth)
                )
        ).toBe(true);
        await testInfo.attach('visual-reply-mobile', {
            body: await page.screenshot({ fullPage: true }),
            contentType: 'image/png',
        });
    });

    test('user reads accurate stage proportions including the smallest stage', async ({ page }) => {
        const reply = await openReply(page);
        const bars = await reply
            .locator('.visual-reply-funnel-bar')
            .evaluateAll((elements) =>
                elements.map((element) => element.getBoundingClientRect().width)
            );
        expect(bars[1]! / bars[0]!).toBeCloseTo(2 / 3, 2);
        expect(bars[3]! / bars[0]!).toBeCloseTo(0.7 / 3, 2);
    });

    test('user reads the same report on a light thread without a forced dark panel', async ({
        page,
    }, testInfo) => {
        await page.setViewportSize({ width: 1120, height: 1000 });
        const reply = await openReply(page, 'official-dashboard-light');
        await expect(reply.locator('.visual-reply-root')).toHaveCSS('color-scheme', 'light');
        await expect(
            reply.getByRole('heading', { name: 'Sales pipeline', exact: true })
        ).toBeVisible();
        await testInfo.attach('visual-reply-light', {
            body: await page.screenshot({ fullPage: true }),
            contentType: 'image/png',
        });
    });

    test('user inspects the chart and explicitly sends a follow-up prompt', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        const reply = await openReply(page, 'open-ui-and-artifact');
        const chart = reply.getByRole('application');
        await chart.focus();
        await chart.press('ArrowLeft');
        await expect(reply.getByTestId('bar-chart-tooltip')).toContainText('141K');
        await chart.press('Escape');
        await expect(reply.getByTestId('bar-chart-tooltip')).toHaveCount(0);

        await reply.getByRole('button', { name: 'Break down pipeline by region' }).click();
        await expect(page.getByRole('status')).toContainText(
            "Conversation prompt: Break down this quarter's sales pipeline by region"
        );

        const artifact = page.frameLocator('iframe[title="Interactive bubble sort artifact"]');
        await artifact.getByRole('button', { name: 'Next comparison' }).click();
        await expect(artifact.locator('[data-comparisons]')).toHaveText('1');
        await expect(artifact.locator('[data-swaps]')).toHaveText('1');
        await artifact.getByRole('button', { name: 'Reset', exact: true }).click();
        await expect(artifact.locator('[data-comparisons]')).toHaveText('0');
    });
});
