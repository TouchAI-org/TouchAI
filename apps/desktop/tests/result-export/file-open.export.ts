import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

const desktopRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const markstreamEntry = fileURLToPath(import.meta.resolve('markstream-vue'));
const parserEntry = realpathSync(createRequire(markstreamEntry).resolve('stream-markdown-parser'));
const parserEsmEntry = join(dirname(parserEntry), 'index.js');

test('user opens a transferred result from file and keeps widget interaction offline', async ({
    page,
}) => {
    const root = await mkdtemp(join(tmpdir(), 'touchai-result-export-'));
    let transferredRoot: string | null = null;
    try {
        const bundlePath = join(root, 'result-export.fixture.js');
        const runnerPath = join(root, 'runner.html');
        const generatedPath = join(root, 'generated.html');
        transferredRoot = await mkdtemp(join(tmpdir(), 'touchai-result-transferred-'));
        const transferredPath = join(transferredRoot, 'TouchAI-result.html');

        await build({
            entryPoints: [join(desktopRoot, 'src/modules/result-export/document.ts')],
            outfile: bundlePath,
            bundle: true,
            format: 'iife',
            globalName: 'TouchAIResultExport',
            platform: 'browser',
            alias: {
                '@': join(desktopRoot, 'src'),
                // The fixture only needs the parser re-exported by markstream-vue.
                // Bundling markstream-vue's full Vue entry breaks CJS interop in
                // the standalone IIFE and pulls optional renderers into the test.
                'markstream-vue': parserEsmEntry,
            },
            external: [
                '@antv/infographic',
                '@terrastruct/d2',
                'katex',
                'katex/dist/contrib/mhchem',
                'mermaid',
                'stream-diffs',
                'stream-monaco',
            ],
            logLevel: 'silent',
        });
        await writeFile(
            runnerPath,
            '<!doctype html><meta charset="utf-8"><body><script src="./result-export.fixture.js"></script></body>',
            'utf8'
        );
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.goto(pathToFileURL(runnerPath).href);
        expect(pageErrors).toEqual([]);

        const html = await page.evaluate(async () => {
            const fixture = (
                window as unknown as Window & {
                    TouchAIResultExport: {
                        buildResultExportDocument(options: {
                            message: unknown;
                            presentation: unknown;
                        }): Promise<{ html: string }>;
                    };
                }
            ).TouchAIResultExport;
            const result = await fixture.buildResultExportDocument({
                message: {
                    role: 'assistant',
                    parts: [
                        { id: 'text-1', type: 'text', content: 'Portable result body' },
                        { id: 'widget-1', type: 'widget', widgetId: 'widget-1' },
                    ],
                    widgets: [
                        {
                            id: 'internal-row-id',
                            callId: 'internal-call-id',
                            widgetId: 'widget-1',
                            title: 'Interactive total',
                            description: '',
                            mode: 'render',
                            phase: 'ready',
                            updatedAt: 1,
                            html: [
                                '<div>',
                                '<button id="increment" type="button">Count: <output id="count">0</output></button>',
                                '<button type="button" data-send-prompt="Continue in TouchAI">Continue</button>',
                                '<button type="button" data-open-link="javascript:document.body.dataset.unsafeLink=\'true\'">Unsafe link</button>',
                                '</div>',
                                '<script>',
                                "document.getElementById('increment').addEventListener('click', () => {",
                                "  document.getElementById('count').textContent = '1';",
                                '});',
                                '</script>',
                            ].join('\n'),
                        },
                    ],
                },
                presentation: {
                    theme: {
                        '--color-background-primary': '#fbfbf6',
                        '--color-text-primary': '#4a4039',
                        '--color-border-secondary': 'rgba(95,94,90,.3)',
                        '--font-serif': "'Segoe UI', serif",
                        '--font-mono': 'monospace',
                        '--border-radius-md': '10px',
                    },
                    themeFallbacks: {},
                    baseStyles: '[data-result-widget]{display:block;max-width:680px;margin:0 auto}',
                    allowedResourceHosts: [
                        'cdnjs.cloudflare.com',
                        'cdn.jsdelivr.net',
                        'unpkg.com',
                        'esm.sh',
                    ],
                },
            });
            return result.html;
        });
        await writeFile(generatedPath, html, 'utf8');

        expect(html).not.toContain('src="file:');
        expect(html).not.toContain('internal-row-id');
        expect(html).not.toContain('internal-call-id');

        // Simulate copying only the HTML file to another machine.
        await writeFile(transferredPath, html, 'utf8');
        await rm(generatedPath);

        const networkRequests: string[] = [];
        page.on('request', (request) => {
            if (/^https?:/i.test(request.url())) networkRequests.push(request.url());
        });

        await page.goto(pathToFileURL(transferredPath).href);
        await expect(page.getByText('Portable result body')).toBeVisible();
        const widget = page.frameLocator('iframe[sandbox="allow-scripts"]');
        await expect(widget.getByRole('button', { name: /Count:/ })).toBeVisible();
        await widget.getByRole('button', { name: /Count:/ }).click();
        await expect(widget.locator('#count')).toHaveText('1');
        await widget.getByRole('button', { name: 'Continue' }).click();
        await expect(widget.locator('[data-result-offline-action]')).toContainText(
            'This action requires TouchAI'
        );
        await widget.getByRole('button', { name: 'Unsafe link' }).click();
        await expect(widget.locator('body')).not.toHaveAttribute('data-unsafe-link');
        expect(networkRequests).toEqual([]);
    } finally {
        await rm(root, { recursive: true, force: true });
        if (transferredRoot) await rm(transferredRoot, { recursive: true, force: true });
    }
});
