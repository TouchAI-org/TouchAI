import { waitForE2eBridge, waitForTestIdDisplayed } from '../support/desktop.js';

/**
 * Measures which `@font-face` declarations make the engine interpolate the variable
 * axis, using a discriminator that cannot be confused with a fallback.
 *
 * Earlier attempts counted ink pixels, and that number meant different things on
 * different engines: 2316 was the real font on one build and a fallback on another.
 * Raster diffs failed the same way, because comparing two fallbacks reads as a match.
 *
 * Advance width at different requested weights is unambiguous. A variable font with
 * `wght` 250..900 gets wider as the weight rises, so 250 and 400 differ. A static face
 * or a fallback has no instance at 250, so the engine maps 250 and 400 to the same
 * nearest face and the widths are identical. If `width(250) < width(400) < width(700)`
 * with 250 distinct from 400, the axis is really being applied.
 */
const HAN = '通用启动与窗口永';
const LATIN = 'Rgax 1234 WwMm';

describe('probe variable axis activation', () => {
    it('reports which declarations interpolate the weight axis', async () => {
        await waitForE2eBridge();
        await waitForTestIdDisplayed('search-view');

        const report = await browser.executeAsync(
            (han, latin, done) => {
                (async () => {
                    const injected = document.querySelector('style[data-touchai-font-face]');
                    const ruleText = injected?.textContent ?? '';
                    const fontUrl = ruleText.match(/url\('([^']+)'\)/)?.[1];

                    if (!fontUrl) {
                        return { error: 'the app did not inject a font rule' };
                    }

                    await document.fonts.ready;

                    function widthAt(fontFamily, weight, text) {
                        const span = document.createElement('span');
                        span.style.cssText = [
                            `font-family:${fontFamily}`,
                            `font-weight:${weight}`,
                            'font-size:48px',
                            'position:absolute',
                            'visibility:hidden',
                            'white-space:pre',
                        ].join(';');
                        span.textContent = text;
                        document.body.appendChild(span);
                        const { width } = span.getBoundingClientRect();
                        span.remove();
                        return Math.round(width * 100) / 100;
                    }

                    function profile(fontFamily) {
                        const hanWidths = {
                            250: widthAt(fontFamily, 250, han),
                            400: widthAt(fontFamily, 400, han),
                            700: widthAt(fontFamily, 700, han),
                        };
                        const latinWidths = {
                            250: widthAt(fontFamily, 250, latin),
                            400: widthAt(fontFamily, 400, latin),
                            700: widthAt(fontFamily, 700, latin),
                        };
                        // The axis is applied when 250 and 400 differ: no static face can
                        // satisfy both weights, so a fallback collapses them together.
                        const hanAxis = hanWidths[250] !== hanWidths[400];
                        const latinAxis = latinWidths[250] !== latinWidths[400];
                        const monotonic =
                            hanWidths[250] < hanWidths[400] && hanWidths[400] < hanWidths[700];
                        return {
                            hanWidths,
                            latinWidths,
                            interpolatesAxis: hanAxis || latinAxis,
                            monotonic,
                        };
                    }

                    // Every declaration worth testing, including the non-standard one the
                    // product currently ships.
                    const candidates = [
                        {
                            name: 'current-supports-variations',
                            src: `url('${fontUrl}') format('woff2 supports variations')`,
                        },
                        {
                            name: 'woff2-variations',
                            src: `url('${fontUrl}') format('woff2-variations')`,
                        },
                        {
                            name: 'woff2-plus-tech-variations',
                            src: `url('${fontUrl}') format('woff2') tech(variations)`,
                        },
                        { name: 'plain-woff2', src: `url('${fontUrl}') format('woff2')` },
                        { name: 'no-format', src: `url('${fontUrl}')` },
                    ];

                    const results = [];
                    for (const candidate of candidates) {
                        const family = `Probe_${candidate.name.replace(/[^a-z0-9]/gi, '_')}`;
                        const style = document.createElement('style');
                        style.textContent = `
                            @font-face {
                                font-family: '${family}';
                                src: ${candidate.src};
                                font-weight: 250 900;
                                font-style: normal;
                                font-display: block;
                            }
                        `;
                        document.head.appendChild(style);

                        let loadError = null;
                        try {
                            await document.fonts.load(`48px '${family}'`);
                        } catch (error) {
                            loadError = String(error).slice(0, 120);
                        }
                        await document.fonts.ready;
                        await new Promise((resolve) => setTimeout(resolve, 250));

                        const faces = [...document.fonts].filter((face) => face.family === family);

                        results.push({
                            name: candidate.name,
                            ...profile(`'${family}'`),
                            faceCount: faces.length,
                            faceStatus: faces.map((face) => face.status),
                            loadError,
                        });
                    }

                    // The family the app declares, for comparison.
                    await document.fonts.load("48px 'TouchAI Source Han Serif SC'");
                    await document.fonts.ready;

                    return {
                        webview2: navigator.userAgent.match(/Edg\/[\d.]+/)?.[0] ?? 'unknown',
                        appFamily: profile("'TouchAI Source Han Serif SC'"),
                        genericSerif: profile('serif'),
                        results,
                        ruleHead: ruleText.replace(/\s+/g, ' ').slice(0, 160),
                    };
                })()
                    .then((result) => done(result))
                    .catch((error) => done({ error: String(error).slice(0, 250) }));
            },
            HAN,
            LATIN
        );

        console.log('AXIS_MATRIX ' + JSON.stringify(report));
    });
});
