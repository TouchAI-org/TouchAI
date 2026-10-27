/**
 * User flow: the app loads its own interface font.
 *
 * The product ships no font file. `src/utils/font.ts` downloads Source Han Serif
 * into `<app root>/assets/font/` and injects `@font-face` pointing at the Tauri
 * asset protocol, which resolves to `http://asset.localhost` on Windows.
 *
 * This exists because two separate things used to make that silently fail, and
 * neither was visible without looking:
 *
 *   1. `font-src` did not list `http:`, so the CSP blocked the request even though
 *      the asset protocol served it. Every serif element fell back to Times New
 *      Roman for real users.
 *   2. The E2E suite provisioned the file but rewrote the rule to a `data:` source
 *      to work around that, so the app's own loading path was never exercised.
 *
 * The suite now provides the file and lets the app load it the normal way, and this
 * spec fails loudly if it cannot. A baseline rendered with a fallback face is worse
 * than no baseline, because it looks green while depicting an interface nobody sees.
 */
import { waitForE2eBridge, waitForTestIdDisplayed } from '../support/desktop.js';

const PRODUCT_FAMILY = 'TouchAI Source Han Serif SC';

describe('user sees the interface rendered in the product typeface', () => {
    it('user sees the app load the product font through the asset protocol', async () => {
        await waitForE2eBridge();
        await waitForTestIdDisplayed('search-view');

        // WebdriverIO 10 removed `executeAsync`; `execute` awaits an async script and
        // resolves with its return value, so the callback form is no longer needed. A
        // throw inside it rejects the call, which is why the success flag is the only
        // shape the result needs.
        const report = await browser.execute(async () => {
            // The function body runs in the renderer, so it cannot close over a
            // module-scope constant.
            const probe = "16px 'TouchAI Source Han Serif SC'";
            const style = document.querySelector('style[data-touchai-font-face]');

            if (!style) {
                return { ok: false, error: 'the app did not inject its @font-face rule' };
            }

            const source = style.textContent ?? '';
            const url = source.match(/url\('([^']+)'\)/)?.[1] ?? null;

            // `document.fonts.load` resolves only once the browser has fetched and
            // parsed the file, so this waits for the real network path rather than
            // checking a computed style that would report a fallback either way.
            await document.fonts.load(probe);
            await document.fonts.ready;

            return {
                ok: true,
                url,
                usesDataUrl: source.includes('data:font'),
                available: document.fonts.check(probe),
            };
        });

        if (!report?.ok) {
            throw new Error(
                `The app could not load its own font (${report?.error ?? 'unknown error'}). Visual baselines would show a fallback face.`
            );
        }

        // The whole point is that the app's real loading path works: a test-side
        // `data:` substitution would pass this check while users still see a fallback.
        if (report.usesDataUrl) {
            throw new Error(
                "The @font-face rule uses a data: URL injected by the test, so the app's own asset-protocol loading path was not exercised."
            );
        }

        if (!report.available) {
            throw new Error(
                `The product font " ${PRODUCT_FAMILY} " is declared but does not resolve, so the interface is rendering a fallback face.`
            );
        }
    });
});
