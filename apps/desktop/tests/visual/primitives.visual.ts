import { expect, test } from '@playwright/test';

/**
 * Visual tests for the component primitives.
 *
 * Each story is opened through Storybook's own iframe route (`iframe.html`), which
 * renders the story with no Storybook chrome. What is compared is therefore the
 * component and nothing else, at a viewport pinned per test.
 *
 * The story list is read from Storybook's `index.json` at run time rather than
 * hard-coded here: a new story becomes a baseline automatically, so adding a
 * variant cannot leave it silently untested.
 */
const DEFAULT_VIEWPORT = { width: 900, height: 700 };

test.describe('user reviews component primitives', () => {
    test('user sees every primitive story rendered consistently', async ({ page, request }) => {
        const index = await request.get('/index.json');
        expect(index.ok(), 'Storybook index.json must be reachable').toBe(true);

        const { entries } = await index.json();
        const stories = Object.values(entries).filter(
            (entry) => entry.type === 'story' && !entry.id.includes('--docs')
        ) as Array<{ id: string; title: string }>;

        expect(stories.length, 'no stories were discovered').toBeGreaterThan(0);

        for (const story of stories) {
            await page.setViewportSize(DEFAULT_VIEWPORT);
            await page.goto(`/iframe.html?id=${story.id}&viewMode=story`);

            // Storybook sets this attribute once the story has rendered and its
            // decorators have run; comparing before it appears captures a blank page.
            await page.waitForSelector('#storybook-root > *', { state: 'attached' });
            await page.waitForFunction(() => document.fonts.status === 'loaded');
            await expect(page.locator('#storybook-root')).toHaveScreenshot(`${story.id}.png`);
        }
    });
});

/**
 * Guards the fidelity of this layer.
 *
 * Component baselines are only meaningful if they render the same tokens and the
 * same typeface as the app. `preview-head.html` declares the product font and
 * `preview.ts` imports `tailwind.css`; if either stops happening, every story
 * would still "pass" while describing a different interface.
 */
test.describe('user trusts the component baselines', () => {
    test('user sees stories rendered with the product font and tokens', async ({ page }) => {
        await page.goto('/iframe.html?id=primitives-button--variants&viewMode=story');
        await page.waitForSelector('#storybook-root > *', { state: 'attached' });

        const report = await page.evaluate(async () => {
            await document.fonts.ready;
            const rootStyle = getComputedStyle(document.documentElement);

            return {
                // The family is set by the decorator in `preview.ts`, which is what
                // makes an unstyled story look like the app instead of like a
                // browser default.
                fontFamily: rootStyle.fontFamily,
                productFontAvailable: document.fonts.check("16px 'TouchAI Source Han Serif SC'"),
                primaryToken: rootStyle.getPropertyValue('--color-primary-500').trim(),
                serifToken: rootStyle.getPropertyValue('--font-serif').trim(),
            };
        });

        expect(report.productFontAvailable, 'the product font must load in stories').toBe(true);
        expect(report.primaryToken, 'the app colour tokens must be present').not.toBe('');
        expect(report.serifToken, 'the app font tokens must be present').toContain(
            'TouchAI Source Han Serif SC'
        );
    });
});
