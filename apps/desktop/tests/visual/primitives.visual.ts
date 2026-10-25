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

/**
 * Stories whose visual result escapes `#storybook-root`.
 *
 * Reka UI renders `Dialog`, `Tooltip`, `Popover`, `Select` and `DropdownMenu` through
 * a portal into `document.body` and positions them with `position: fixed`. Taking the
 * screenshot of `#storybook-root` for those captures an empty rectangle the height of
 * the trigger, which compares "successfully" while showing nothing — the exact failure
 * mode a visual gate must not have. Those stories are captured as the full page
 * instead.
 */
const PORTALLED_STORIES = new Set([
    'primitives-dialog--open',
    'primitives-tooltip--open',
    'primitives-popover--open',
    'primitives-select--open',
    'primitives-dropdownmenu--open',
]);

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

            // Storybook renders the story asynchronously; comparing before this
            // selector appears captures a blank page.
            await page.waitForSelector('#storybook-root > *', { state: 'attached' });
            await page.waitForFunction(() => document.fonts.status === 'loaded');
            // Portalled content is positioned in a layout pass after mount, so a
            // screenshot immediately after `fonts.status` can catch it mid-place.
            await page.waitForTimeout(300);

            const target = PORTALLED_STORIES.has(story.id)
                ? page.locator('body')
                : page.locator('#storybook-root');

            await expect(target).toHaveScreenshot(`${story.id}.png`);
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

    /**
     * A screenshot of an empty rectangle still produces a passing baseline, so the
     * portalled stories need proof that something was actually captured.
     */
    test('user sees portalled stories capture their content', async ({ page }) => {
        await page.goto('/iframe.html?id=primitives-dialog--open&viewMode=story');
        await page.waitForSelector('#storybook-root > *', { state: 'attached' });

        const content = await page.evaluate(() => {
            const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
            if (!dialog) {
                return null;
            }

            const box = dialog.getBoundingClientRect();
            return {
                width: Math.round(box.width),
                height: Math.round(box.height),
                inStorybookRoot: Boolean(
                    document.querySelector('#storybook-root')?.contains(dialog)
                ),
            };
        });

        expect(content, 'the dialog must render').not.toBeNull();
        expect(content!.width, 'the dialog must have a real width').toBeGreaterThan(200);
        expect(content!.height, 'the dialog must have a real height').toBeGreaterThan(80);
        expect(
            content!.inStorybookRoot,
            'a portalled dialog lives outside #storybook-root, which is why it is captured as the full page'
        ).toBe(false);
    });
});
