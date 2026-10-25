/**
 * Records which `@font-face` src declarations the running WebView2 accepts.
 *
 * The product ships a variable font (Source Han Serif SC VF) and declares a weight
 * range. On WebView2 156 the plain `format('woff2')` hint makes the engine treat the
 * file as static, find no instance for the requested weight, and silently paint the
 * fallback instead. Adding `supports variations` fixes 156. WebView2 155 — what the CI
 * runner has preinstalled, and what a user with an old runtime would have — rejects
 * that hint instead.
 *
 * Guessing between those behaviours has already produced four wrong fixes, so this
 * probe measures each candidate on whatever engine actually runs it and prints the
 * results. It never fails: its output is the deliverable.
 */
import { waitForE2eBridge, waitForTestIdDisplayed } from '../support/desktop.js';

const HAN_SAMPLE = '通用启动';

describe('probe font source formats', () => {
    it('reports which src declarations paint the shipped font', async () => {
        await waitForE2eBridge();
        await waitForTestIdDisplayed('search-view');

        const report = await browser.executeAsync((sample, done) => {
            (async () => {
                const injected = document.querySelector('style[data-touchai-font-face]');
                const ruleText = injected?.textContent ?? '';
                const fontUrl = ruleText.match(/url\('([^']+)'\)/)?.[1];

                if (!fontUrl) {
                    return { error: 'the app did not inject a font rule' };
                }

                await document.fonts.ready;

                /**
                 * Rasterises Han text through a family and returns how many pixels carry
                 * ink. Han is the only reliable discriminator here: advance widths of
                 * Song-style faces coincide, and a Latin-only fallback draws tofu boxes
                 * for Han, which have a very different ink count.
                 */
                function inkCount(fontFamily) {
                    const canvas = document.createElement('canvas');
                    canvas.width = 460;
                    canvas.height = 110;
                    const context = canvas.getContext('2d');
                    context.fillStyle = '#ffffff';
                    context.fillRect(0, 0, canvas.width, canvas.height);
                    context.fillStyle = '#000000';
                    context.font = `52px ${fontFamily}`;
                    context.textBaseline = 'top';
                    context.fillText(sample, 6, 10);
                    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
                    let dark = 0;
                    for (let index = 0; index < data.length; index += 4) {
                        if (data[index] < 128) {
                            dark += 1;
                        }
                    }
                    return dark;
                }

                // Baseline: what the page falls back to when nothing matches.
                const fallbackInk = inkCount('serif');

                const candidates = [
                    { name: 'woff2', src: `url('${fontUrl}') format('woff2')` },
                    {
                        name: 'woff2-variations',
                        src: `url('${fontUrl}') format('woff2-variations')`,
                    },
                    {
                        name: 'supports-variations',
                        src: `url('${fontUrl}') format('woff2 supports variations')`,
                    },
                    {
                        name: 'supports-variations-then-woff2',
                        src: `url('${fontUrl}') format('woff2 supports variations'), url('${fontUrl}') format('woff2')`,
                    },
                    {
                        name: 'woff2-then-supports-variations',
                        src: `url('${fontUrl}') format('woff2'), url('${fontUrl}') format('woff2 supports variations')`,
                    },
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

                    try {
                        await document.fonts.load(`52px '${family}'`);
                    } catch (error) {
                        results.push({
                            name: candidate.name,
                            ink: null,
                            error: String(error).slice(0, 120),
                        });
                        continue;
                    }
                    await document.fonts.ready;
                    // Give the engine a beat to settle the face before rasterising.
                    await new Promise((resolve) => setTimeout(resolve, 250));

                    const ink = inkCount(`'${family}'`);
                    const faces = [...document.fonts].filter((face) => face.family === family);

                    results.push({
                        name: candidate.name,
                        ink,
                        paintsFont: Math.abs(ink - fallbackInk) > 500,
                        faceStatus: faces.map((face) => face.status),
                        faceWeight: faces.map((face) => face.weight),
                    });
                }

                // The app's own rule, for comparison with the candidates above.
                await document.fonts.load("52px 'TouchAI Source Han Serif SC'");
                await document.fonts.ready;

                return {
                    webview2: navigator.userAgent.match(/Edg\/[\d.]+/)?.[0] ?? 'unknown',
                    fallbackInk,
                    appRuleInk: inkCount("'TouchAI Source Han Serif SC'"),
                    appRuleText: ruleText.replace(/\s+/g, ' ').trim(),
                    results,
                };
            })()
                .then((result) => done(result))
                .catch((error) => done({ error: String(error).slice(0, 250) }));
        }, HAN_SAMPLE);

        console.log('FONT_SRC_MATRIX ' + JSON.stringify(report));
    });
});
