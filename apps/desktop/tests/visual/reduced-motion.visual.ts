import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const motionStyles = fileURLToPath(new URL('../../src/styles/motion.css', import.meta.url));

for (const preference of ['no-preference', 'reduce', 'shared-policy'] as const) {
    test(`user with ${preference} motion keeps their reading position when list offsets change`, async ({
        page,
    }) => {
        await page.emulateMedia({
            reducedMotion: preference === 'reduce' ? 'reduce' : 'no-preference',
        });
        await page.setContent(`
            <section style="height:600px;overflow:auto;overflow-anchor:none">
                <div style="position:relative;height:8000px">
                    <div id="question" style="position:absolute;top:3000px;height:100px">
                        Selected question
                    </div>
                </div>
            </section>
        `);
        await page.addStyleTag({ path: motionStyles });
        await page.evaluate((shared) => {
            document.documentElement.toggleAttribute('data-reduced-motion', shared);
        }, preference === 'shared-policy');

        const offsets = await page.evaluate(async () => {
            const viewport = document.querySelector('section')!;
            const question = document.getElementById('question')!;
            const offset = () =>
                question.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
            const nextFrame = () =>
                new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

            viewport.scrollTop = 2750;
            await nextFrame();
            const before = offset();

            // A virtual list updates the row offset and compensates the viewport
            // together. The next layout reader must see those changes together too.
            question.style.top = '2200px';
            viewport.scrollBy({ top: -800, behavior: 'instant' });
            const duringLayout = offset();
            await nextFrame();
            await nextFrame();
            return { before, duringLayout, after: offset() };
        });

        expect(offsets.before).toBe(250);
        expect(Math.abs(offsets.duringLayout - offsets.before)).toBeLessThanOrEqual(1);
        expect(Math.abs(offsets.after - offsets.before)).toBeLessThanOrEqual(1);
    });
}

test('user who reduces motion still completes a dialog exit when it closes', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setContent('<div class="t-modal" data-state="open" role="dialog">Dialog</div>');
    await page.addStyleTag({ path: motionStyles });

    const opacityAfterExit = await page.evaluate(async () => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
        await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
        // Reka presence relies on this browser event to release retained content.
        return new Promise<string>((resolve) => {
            dialog.addEventListener(
                'animationend',
                () => resolve(getComputedStyle(dialog).opacity),
                {
                    once: true,
                }
            );
            dialog.dataset.state = 'closed';
        });
    });

    expect(opacityAfterExit).toBe('0');
});
