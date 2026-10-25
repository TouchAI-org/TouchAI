import { waitForE2eBridge, waitForTestIdDisplayed } from '../support/desktop.js';

/**
 * Reports which declarations paint the shipped variable font, using a discriminator
 * that survives synthetic bolding and fallbacks alike.
 *
 * What failed before:
 *
 *   - ink counts: the same value meant "real font" on one engine and "fallback" on
 *     another, because a fallback that lacks Han draws tofu boxes with a similar ink
 *     budget to real Han strokes.
 *   - advance width across weights: browsers apply synthetic bold to any family, so a
 *     fallback also widens from 250 to 700 and looks like an interpolating axis.
 *   - pixel diffs against `serif`: when both sides fall back, they match and the check
 *     passes.
 *
 * What cannot be faked: the outline itself. The file is fetched in the page, so its
 * glyph can be drawn directly through a `FontFace` built from those bytes. Comparing a
 * declared family against that direct render answers "is this the shipped font", and
 * no installed font participates on either side.
 */
describe('probe painted outlines against the file', () => {
    it('reports outline agreement for each declaration', async () => {
        await waitForE2eBridge();
        await waitForTestIdDisplayed('search-view');

        const report = await browser.executeAsync((done) => {
            (async () => {
                const injected = document.querySelector('style[data-touchai-font-face]');
                const ruleText = injected?.textContent ?? '';
                const fontUrl = ruleText.match(/url\('([^']+)'\)/)?.[1];

                if (!fontUrl) {
                    return { error: 'the app did not inject a font rule' };
                }

                await document.fonts.ready;

                /**
                 * Rasterises one Han character at a fixed weight and returns the pixel
                 * buffer. Comparing buffers detects a different outline; comparing widths
                 * would not, because synthetic bold also changes widths.
                 */
                function raster(fontFamily, weight, character) {
                    const canvas = document.createElement('canvas');
                    canvas.width = 240;
                    canvas.height = 240;
                    const context = canvas.getContext('2d');
                    context.fillStyle = '#ffffff';
                    context.fillRect(0, 0, 240, 240);
                    context.fillStyle = '#000000';
                    context.font = `${weight} 170px ${fontFamily}`;
                    context.textBaseline = 'top';
                    context.fillText(character, 12, 12);
                    return context.getImageData(0, 0, 240, 240).data;
                }

                function differing(first, second) {
                    let changed = 0;
                    for (let index = 0; index < first.length; index += 4) {
                        if (first[index] !== second[index]) {
                            changed += 1;
                        }
                    }
                    return changed;
                }

                // Reference: the same bytes, registered directly, drawn at weight 400.
                const referenceStyle = document.createElement('style');
                referenceStyle.textContent = `
                    @font-face {
                        font-family: 'ProbeReferenceFace';
                        src: url('${fontUrl}') format('woff2');
                        font-weight: 250 900;
                        font-style: normal;
                        font-display: block;
                    }
                `;
                document.head.appendChild(referenceStyle);
                await document.fonts.load("170px 'ProbeReferenceFace'");
                await document.fonts.ready;
                await new Promise((resolve) => setTimeout(resolve, 300));

                const sample = '通';
                const reference = raster("'ProbeReferenceFace'", 400, sample);
                const serifRaster = raster('serif', 400, sample);

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
                        await document.fonts.load(`170px '${family}'`);
                    } catch (error) {
                        loadError = String(error).slice(0, 120);
                    }
                    await document.fonts.ready;
                    await new Promise((resolve) => setTimeout(resolve, 250));

                    const faces = [...document.fonts].filter((face) => face.family === family);
                    const painted = raster(`'${family}'`, 400, sample);

                    results.push({
                        name: candidate.name,
                        diffFromFile: differing(painted, reference),
                        diffFromSerif: differing(painted, serifRaster),
                        paintsFile: differing(painted, reference) < 500,
                        faceCount: faces.length,
                        faceStatus: faces.map((face) => face.status),
                        loadError,
                    });
                }

                await document.fonts.load("170px 'TouchAI Source Han Serif SC'");
                await document.fonts.ready;
                const appPainted = raster("'TouchAI Source Han Serif SC'", 400, sample);

                return {
                    webview2: navigator.userAgent.match(/Edg\/[\d.]+/)?.[0] ?? 'unknown',
                    referenceVsSerif: differing(reference, serifRaster),
                    appDiffFromFile: differing(appPainted, reference),
                    appDiffFromSerif: differing(appPainted, serifRaster),
                    appPaintsFile: differing(appPainted, reference) < 500,
                    results,
                    ruleHead: ruleText.replace(/\s+/g, ' ').slice(0, 160),
                };
            })()
                .then((result) => done(result))
                .catch((error) => done({ error: String(error).slice(0, 250) }));
        });

        console.log('OUTLINE_MATRIX ' + JSON.stringify(report));
    });
});
