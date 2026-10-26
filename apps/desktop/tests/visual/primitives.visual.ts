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
 * The instant every story renders at.
 *
 * `ActivityHeatmap` derives its `yearWindow` from `new Date()`, so the right edge of the
 * grid is the current week: the whole calendar shifts whenever the calendar advances and
 * the committed baseline starts failing on pull requests that changed nothing. Pinning
 * the clock makes the render a function of the code rather than of the day the suite
 * runs. `setFixedTime` fixes `Date` while leaving timers running, so the components'
 * animations and the stabilising waits below still behave normally.
 */
const FIXED_NOW = new Date('2026-10-26T12:00:00Z');

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

        // Storybook's index shape, narrowed here so the filter below is typed.
        interface StorybookEntry {
            type: string;
            id: string;
            title: string;
        }

        const { entries } = (await index.json()) as { entries: Record<string, StorybookEntry> };
        const stories = Object.values(entries).filter(
            (entry) => entry.type === 'story' && !entry.id.includes('--docs')
        );

        expect(stories.length, 'no stories were discovered').toBeGreaterThan(0);

        for (const story of stories) {
            await page.setViewportSize(DEFAULT_VIEWPORT);
            // Before `goto`, so the story's first render already sees the pinned clock.
            await page.clock.setFixedTime(FIXED_NOW);
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

            // Soft, so one moved baseline does not abort the loop and hide every later
            // story. `toHaveScreenshot` throws, and a plain `expect` here meant a pull
            // request with two regressions reported only the first — the second went
            // unmentioned until the first was fixed.
            await expect.soft(target).toHaveScreenshot(`${story.id}.png`);
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
            const family = 'TouchAI Source Han Serif SC';
            // A family that cannot exist. If the product face is missing or rejected, the
            // engine falls back for both and the two renders become identical, which is
            // what makes the comparison below a real test rather than a restatement.
            const missingFamily = 'TouchAI Missing Font 9x8z';
            const probe = `52px '${family}'`;

            await document.fonts.load(probe);
            await document.fonts.load(`52px '${missingFamily}'`);
            await document.fonts.ready;

            const faces = [...document.fonts].filter((face) => face.family === family);

            function rasterise(target: string) {
                const canvas = document.createElement('canvas');
                canvas.width = 260;
                canvas.height = 70;
                const context = canvas.getContext('2d')!;
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, canvas.width, canvas.height);
                context.fillStyle = '#000000';
                context.font = `52px ${target}`;
                context.textBaseline = 'top';
                // Han glyphs, so a Latin-only fallback cannot match by accident.
                context.fillText('通用启动', 4, 6);
                return context.getImageData(0, 0, canvas.width, canvas.height).data;
            }

            const product = rasterise(`'${family}'`);
            const missing = rasterise(`'${missingFamily}'`);
            let differingPixels = 0;
            for (let index = 0; index < product.length; index += 4) {
                if (product[index] !== missing[index]) {
                    differingPixels += 1;
                }
            }

            const rootStyle = getComputedStyle(document.documentElement);

            return {
                // `document.fonts.check()` returns true even for a family that exists
                // nowhere, so the two facts that actually distinguish a working face are
                // a registered `FontFace` and an outline that differs from a fallback.
                productFaceCount: faces.length,
                productFaceStatus: faces.map((face) => face.status),
                differingPixels,
                primaryToken: rootStyle.getPropertyValue('--color-primary-500').trim(),
                serifToken: rootStyle.getPropertyValue('--font-serif').trim(),
            };
        });

        // Step 1: the engine must have registered a face. A rejected `format()` hint
        // registers none, and then the pixel check below would compare two fallbacks.
        expect(
            report.productFaceCount,
            'the product @font-face must be registered, not rejected by the engine'
        ).toBeGreaterThan(0);
        expect(report.productFaceStatus, 'the product face must have finished loading').toContain(
            'loaded'
        );

        // Step 2: the painted Han outline must differ from a guaranteed-missing family.
        // Equal outlines mean both sides fell back, so the baselines would describe a
        // typeface no user sees.
        expect(
            report.differingPixels,
            'the product font must paint differently from a fallback, or every baseline depicts the wrong typeface'
        ).toBeGreaterThan(500);

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
