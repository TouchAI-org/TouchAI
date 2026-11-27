import { describe, expect, it, vi } from 'vitest';

import { buildResultExportDocument, RESULT_EXPORT_SCHEMA } from '@/modules/result-export/public';

import {
    createReadyResultWidget,
    createResultExportMessage,
    RESULT_EXPORT_TEST_PRESENTATION,
} from '../../utils/resultExport';

function parseResult(html: string): Document {
    return new DOMParser().parseFromString(html, 'text/html');
}

describe('user saves a completed answer', () => {
    it('user saves a text answer as a standalone static result', async () => {
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                parts: [{ id: 'text-1', type: 'text', content: '## Summary\n\nA useful result.' }],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
        });
        const document = parseResult(result.html);

        expect(
            document.querySelector('meta[name="touchai-result-schema"]')?.getAttribute('content')
        ).toBe(RESULT_EXPORT_SCHEMA);
        expect(document.querySelector('h2')?.textContent).toBe('Summary');
        expect(document.querySelector('p')?.textContent).toBe('A useful result.');
        expect(document.querySelector('iframe')).toBeNull();
        expect(result.bytes).toBe(new TextEncoder().encode(result.html).byteLength);
    });

    it('user sees ordinary punctuation in a plain text result without extra formatting', async () => {
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                parts: [
                    {
                        id: 'text-1',
                        type: 'text',
                        content: 'A useful result, with ordinary punctuation; it stays readable.',
                    },
                ],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
        });
        const document = parseResult(result.html);

        expect(document.querySelectorAll('p')).toHaveLength(1);
        expect(document.querySelector('p')?.textContent).toBe(
            'A useful result, with ordinary punctuation; it stays readable.'
        );
        expect(document.querySelectorAll('ul, ol, pre, blockquote')).toHaveLength(0);
    });

    it('user sees a number that starts a Markdown list rendered as a list', async () => {
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                parts: [{ id: 'text-1', type: 'text', content: '1. first item' }],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
        });
        const document = parseResult(result.html);

        expect(document.querySelector('ol > li')?.textContent).toBe('first item');
    });

    it('user sees an explicit external link kept safe', async () => {
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                parts: [
                    {
                        id: 'text-1',
                        type: 'text',
                        content: 'Read [the result](https://example.com/result) for details.',
                    },
                ],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
        });
        const document = parseResult(result.html);
        const link = document.querySelector('a[href="https://example.com/result"]');

        expect(link?.textContent).toBe('the result');
        expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('user sees a bare domain in plain prose kept as a safe external link', async () => {
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                parts: [
                    {
                        id: 'text-1',
                        type: 'text',
                        content: 'Visit example.com for details.',
                    },
                ],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
        });
        const document = parseResult(result.html);
        const link = document.querySelector('a[href="http://example.com"]');

        expect(link?.textContent).toBe('example.com');
        expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('user saves a live widget and keeps its output and interaction script', async () => {
        const widgetHtml = [
            '<div class="artifact">',
            '  <button id="increment" type="button">Count: <span id="count">0</span></button>',
            '  <script>',
            "    document.getElementById('increment')?.addEventListener('click', () => {",
            "      const count = document.getElementById('count');",
            "      if (count) count.textContent = String(Number(count.textContent || '0') + 1);",
            '    });',
            '  </script>',
            '</div>',
        ].join('\n');
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                parts: [
                    { id: 'text-1', type: 'text', content: 'The interactive result:' },
                    { id: 'widget-part-1', type: 'widget', widgetId: 'internal-widget-id' },
                ],
                widgets: [createReadyResultWidget(widgetHtml)],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
        });
        const document = parseResult(result.html);
        const frame = document.querySelector('iframe');

        expect(frame).not.toBeNull();
        expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
        expect(frame?.getAttribute('title')).toBe('Quarterly revenue');
        expect(frame?.getAttribute('srcdoc')).toContain('Count:');
        expect(frame?.getAttribute('srcdoc')).toContain('addEventListener');
        expect(document.body.textContent).toContain('The interactive result:');
    });

    it('user keeps widget text that contains an unescaped less-than sign', async () => {
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                parts: [{ id: 'widget-part-1', type: 'widget', widgetId: 'internal-widget-id' }],
                widgets: [createReadyResultWidget('<div>1 < 2</div>')],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
        });
        const document = parseResult(result.html);

        expect(document.querySelector('iframe')).not.toBeNull();
        expect(document.querySelector('[data-widget-fallback]')).toBeNull();
    });

    it('user sees only visible text and ready widgets in their original order', async () => {
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                id: 'internal-message-id',
                reasoning: 'INTERNAL_REASONING_MARKER',
                parts: [
                    {
                        id: 'reasoning-1',
                        type: 'reasoning',
                        content: 'INTERNAL_REASONING_MARKER',
                    },
                    { id: 'text-1', type: 'text', content: 'VISIBLE_BEFORE' },
                    {
                        id: 'tool-1',
                        type: 'tool_call',
                        toolCall: {
                            id: 'internal-tool-call-id',
                            name: 'search',
                            namespacedName: 'builtin__search',
                            source: 'builtin',
                            arguments: { secret: 'INTERNAL_TOOL_ARGUMENT_MARKER' },
                            result: 'INTERNAL_TOOL_RESULT_MARKER',
                            status: 'completed',
                        },
                    },
                    { id: 'widget-part-1', type: 'widget', widgetId: 'internal-widget-id' },
                    { id: 'text-2', type: 'text', content: 'VISIBLE_AFTER' },
                    {
                        id: 'prompt-1',
                        type: 'text',
                        content: 'INTERNAL_PROMPT_MARKER',
                    },
                ],
                widgets: [
                    createReadyResultWidget(
                        '<div>VISIBLE_WIDGET<script>window.analytics=()=>{}</script></div>'
                    ),
                ],
                prompt: 'INTERNAL_PROMPT_MARKER',
                systemPrompt: 'INTERNAL_SYSTEM_PROMPT_MARKER',
                analytics: { internal: 'INTERNAL_ANALYTICS_MARKER' },
            } as never),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
        });
        const document = parseResult(result.html);
        const resultNodes = [...document.querySelectorAll('[data-result-part]')];

        expect(resultNodes.map((node) => node.getAttribute('data-result-part'))).toEqual([
            'text',
            'widget',
            'text',
        ]);
        expect(result.html).not.toContain('INTERNAL_REASONING_MARKER');
        expect(result.html).not.toContain('INTERNAL_TOOL_ARGUMENT_MARKER');
        expect(result.html).not.toContain('INTERNAL_TOOL_RESULT_MARKER');
        expect(result.html).not.toContain('INTERNAL_PROMPT_MARKER');
        expect(result.html).not.toContain('INTERNAL_SYSTEM_PROMPT_MARKER');
        expect(result.html).not.toContain('INTERNAL_ANALYTICS_MARKER');
        expect(result.html).not.toContain('internal-message-id');
        expect(result.html).not.toContain('internal-tool-call-id');
        expect(result.html).not.toContain('internal-widget-id');
    });

    it('user sees a visible fallback in place of a historical widget that was cut off', async () => {
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                parts: [
                    { id: 'text-1', type: 'text', content: 'The explanation is still here.' },
                    { id: 'widget-part-1', type: 'widget', widgetId: 'internal-widget-id' },
                ],
                widgets: [createReadyResultWidget('<p><span>Half a widget')],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
        });
        const document = parseResult(result.html);
        const fallback = document.querySelector('[data-widget-fallback]');

        expect(document.querySelector('iframe')).toBeNull();
        expect(document.body.textContent).toContain('The explanation is still here.');
        expect(fallback?.textContent).toContain('visualization could not be reconstructed');
    });

    it('user opens the result with a dedicated restrictive policy that keeps widgets isolated', async () => {
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                parts: [
                    { id: 'text-1', type: 'text', content: 'Safe content' },
                    { id: 'widget-part-1', type: 'widget', widgetId: 'internal-widget-id' },
                ],
                widgets: [
                    createReadyResultWidget(
                        '<div><a href="https://example.com">Link</a><script>window.ready = true</script></div>'
                    ),
                ],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
        });
        const document = parseResult(result.html);
        const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
        const frame = document.querySelector('iframe');
        const frameDocument = new DOMParser().parseFromString(
            frame?.getAttribute('srcdoc') ?? '',
            'text/html'
        );
        const framePolicy = frameDocument.querySelector(
            'meta[http-equiv="Content-Security-Policy"]'
        );

        expect(policy?.getAttribute('content')).toContain("default-src 'none'");
        expect(policy?.getAttribute('content')).toContain("object-src 'none'");
        expect(policy?.getAttribute('content')).toContain("base-uri 'none'");
        expect(policy?.getAttribute('content')).toContain("frame-src 'self' data:");
        expect(framePolicy?.getAttribute('content')).toContain("connect-src 'none'");
        expect(framePolicy?.getAttribute('content')).toContain("frame-src 'none'");
        expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
        expect(frame?.getAttribute('sandbox')).not.toContain('allow-same-origin');
    });

    it('user does not preserve scripts from outside the widget CDN allowlist', async () => {
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                parts: [{ id: 'widget-part-1', type: 'widget', widgetId: 'internal-widget-id' }],
                widgets: [
                    createReadyResultWidget(
                        [
                            '<div>Safe widget</div>',
                            '<script src="javascript:alert(1)"></script>',
                            '<script src="https://example.com/tracker.js"></script>',
                            '<script src="https://cdnjs.cloudflare.com/ajax/libs/chart.js/4.4.1/chart.umd.js"></script>',
                        ].join('')
                    ),
                ],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
        });
        const document = parseResult(result.html);
        const srcdoc = document.querySelector('iframe')?.getAttribute('srcdoc') ?? '';

        expect(srcdoc).not.toContain('javascript:alert');
        expect(srcdoc).not.toContain('https://example.com/tracker.js');
        expect(srcdoc).toContain(
            'https://cdnjs.cloudflare.com/ajax/libs/chart.js/4.4.1/chart.umd.js'
        );
    });

    it('user keeps a CDN resource URL when its best-effort inline fetch fails', async () => {
        const fetchResource = vi.fn().mockRejectedValue(new Error('offline'));
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                parts: [{ id: 'widget-part-1', type: 'widget', widgetId: 'internal-widget-id' }],
                widgets: [
                    createReadyResultWidget(
                        '<div><canvas></canvas></div><script src="https://cdnjs.cloudflare.com/ajax/libs/chart.js/4.4.1/chart.umd.js"></script>'
                    ),
                ],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
            fetchResource,
        });
        const document = parseResult(result.html);
        const srcdoc = document.querySelector('iframe')?.getAttribute('srcdoc') ?? '';

        expect(fetchResource).toHaveBeenCalledWith(
            'https://cdnjs.cloudflare.com/ajax/libs/chart.js/4.4.1/chart.umd.js',
            expect.objectContaining({ redirect: 'error' })
        );
        expect(srcdoc).toContain(
            'https://cdnjs.cloudflare.com/ajax/libs/chart.js/4.4.1/chart.umd.js'
        );
        expect(result.warnings).toContain('online-resources');
    });

    it('user gets a fully inlined widget when all CDN resources are available', async () => {
        const fetchResource = vi.fn().mockResolvedValue(
            new Response('window.Chart = class Chart {};', {
                headers: { 'content-type': 'text/javascript' },
            })
        );
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                parts: [{ id: 'widget-part-1', type: 'widget', widgetId: 'internal-widget-id' }],
                widgets: [
                    createReadyResultWidget(
                        '<div><canvas></canvas></div><script src="https://cdnjs.cloudflare.com/ajax/libs/chart.js/4.4.1/chart.umd.js"></script>'
                    ),
                ],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
            fetchResource,
        });
        const document = parseResult(result.html);
        const srcdoc = document.querySelector('iframe')?.getAttribute('srcdoc') ?? '';

        expect(srcdoc).not.toContain(
            'https://cdnjs.cloudflare.com/ajax/libs/chart.js/4.4.1/chart.umd.js'
        );
        expect(srcdoc).toContain('data:text/javascript;base64,');
        expect(result.warnings).not.toContain('online-resources');
    });

    it('user keeps a completed full HTML widget head and inlines its available resources', async () => {
        const fetchResource = vi.fn((url: string) => {
            if (url.endsWith('/missing.css')) {
                return Promise.resolve(new Response('not found', { status: 404 }));
            }
            if (url.endsWith('/available.css')) {
                return Promise.resolve(
                    new Response('.from-cdn{color:green}</STYLE><div>breakout</div>')
                );
            }
            return Promise.resolve(new Response('window.ready = true;'));
        });
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                parts: [{ id: 'widget-part-1', type: 'widget', widgetId: 'internal-widget-id' }],
                widgets: [
                    createReadyResultWidget(
                        [
                            '<!doctype html><html><head>',
                            '<!-- complete head -->',
                            '<style>.inline{color:blue}</style>',
                            '<link rel="stylesheet" media="print" href="https://cdn.jsdelivr.net/missing.css">',
                            '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/available.css">',
                            '<script src="https://unpkg.com/chart.js"></script>',
                            '</head><body><p>Full widget</p></body></html>',
                        ].join('')
                    ),
                ],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
            fetchResource,
        });
        const document = parseResult(result.html);
        const srcdoc = document.querySelector('iframe')?.getAttribute('srcdoc') ?? '';

        expect(srcdoc).toContain('Full widget');
        expect(srcdoc).toContain('.inline{color:blue}');
        expect(srcdoc).toContain('.from-cdn{color:green}');
        expect(srcdoc).toContain('<\\/style>');
        expect(srcdoc).toContain('href="https://cdn.jsdelivr.net/missing.css"');
        expect(srcdoc).toContain('media="print"');
        expect(srcdoc).not.toContain('https://cdnjs.cloudflare.com/available.css');
        expect(srcdoc).toContain('data:text/javascript;base64,');
        expect(result.warnings).toContain('online-resources');
    });

    it('user sees a link title and escaped characters as readable text', async () => {
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                parts: [
                    {
                        id: 'text-1',
                        type: 'text',
                        content:
                            'Read [A & B](https://example.com/result?a=1&b=2 "A < B & \\"quoted\\"") for details.',
                    },
                ],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
        });
        const document = parseResult(result.html);
        const link = document.querySelector('a');

        expect(link?.textContent).toBe('A & B');
        expect(link?.getAttribute('href')).toBe('https://example.com/result?a=1&b=2');
        expect(link?.getAttribute('title')).toBe('A < B & "quoted"');
    });

    it('user does not load a remote Markdown image but keeps an embedded image', async () => {
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                parts: [
                    {
                        id: 'text-1',
                        type: 'text',
                        content: [
                            '![remote](https://example.com/pixel.png)',
                            '',
                            '![embedded](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==)',
                        ].join('\n'),
                    },
                ],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
        });
        const document = parseResult(result.html);
        const images = [...document.querySelectorAll('img')];

        expect(images).toHaveLength(1);
        expect(images[0]?.getAttribute('src')).toMatch(/^data:image\/gif;base64,/);
        expect(result.html).not.toContain('https://example.com/pixel.png');
    });

    it('user sees a fallback when a widget reference has no id', async () => {
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                parts: [{ id: 'widget-part-1', type: 'widget' }],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
        });
        const document = parseResult(result.html);
        const fallback = document.querySelector('[data-widget-fallback]');

        expect(document.querySelector('iframe')).toBeNull();
        expect(fallback?.textContent).toContain('Widget');
        expect(fallback?.textContent).toContain('visualization could not be reconstructed');
    });

    it('user still saves legacy message content when there are no visible text or widget parts', async () => {
        const result = await buildResultExportDocument({
            message: createResultExportMessage({
                content: 'Legacy visible result',
                parts: [{ id: 'reasoning-1', type: 'reasoning', content: 'Hidden reasoning' }],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
        });
        const document = parseResult(result.html);

        expect(document.querySelector('[data-result-part="text"]')?.textContent).toBe(
            'Legacy visible result'
        );
        expect(result.html).not.toContain('Hidden reasoning');
    });

    it('user gets predictable build latency for a two MiB text result', async () => {
        const content = 'a'.repeat(2 * 1024 * 1024);
        const samples: number[] = [];

        for (let run = 0; run < 5; run += 1) {
            const startedAt = performance.now();
            await buildResultExportDocument({
                message: createResultExportMessage({
                    parts: [{ id: 'text-1', type: 'text', content }],
                }),
                presentation: RESULT_EXPORT_TEST_PRESENTATION,
            });
            samples.push(performance.now() - startedAt);
        }

        samples.sort((left, right) => left - right);
        const p50 = samples[Math.floor(samples.length / 2)]!;
        const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
        const saved = await buildResultExportDocument({
            message: createResultExportMessage({
                parts: [{ id: 'text-1', type: 'text', content }],
            }),
            presentation: RESULT_EXPORT_TEST_PRESENTATION,
        });

        expect(saved.html).toContain(content);
        expect(saved.bytes).toBeGreaterThan(content.length);
        expect(p50).toBeLessThanOrEqual(250);
        expect(p95).toBeLessThanOrEqual(1_000);
    }, 20_000);
});
