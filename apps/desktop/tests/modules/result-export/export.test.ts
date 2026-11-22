import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { describe, expect, it, vi } from 'vitest';

import { saveAssistantResultToFile } from '@/app/api/agent/resultExport';
import { MAX_RESULT_EXPORT_BYTES } from '@/modules/result-export/public';

import {
    createReadyResultWidget,
    createResultExportMessage,
    RESULT_EXPORT_TEST_PRESENTATION,
} from '../../utils/resultExport';

const LABELS = {
    dialogTitle: 'Save result',
    filterName: 'HTML result',
};

function exportMessage(content: string, now = new Date(2026, 10, 22, 9, 8, 7)) {
    return saveAssistantResultToFile({
        message: createResultExportMessage({
            parts: [{ id: 'text-1', type: 'text', content }],
        }),
        presentation: RESULT_EXPORT_TEST_PRESENTATION,
        labels: LABELS,
        now,
    });
}

describe('user exports a completed answer to disk', () => {
    it('user cancels the save dialog and no result file is written', async () => {
        mockTauriCommand('plugin:dialog|save', null);

        const result = await exportMessage('Cancel me');

        expect(result.status).toBe('cancelled');
        expect(getTauriInvokeCalls('plugin:dialog|save')).toHaveLength(1);
        expect(getTauriInvokeCalls('plugin:dialog|save')[0]?.payload).toMatchObject({
            options: {
                defaultPath: 'TouchAI-result-20261122-090807.html',
                filters: [{ name: 'HTML result', extensions: ['html'] }],
                title: 'Save result',
            },
        });
        expect(getTauriInvokeCalls('result_export_html')).toHaveLength(0);
    });

    it('user can retry after a write failure and the failed attempt reports no success', async () => {
        mockTauriCommand('plugin:dialog|save', '/tmp/TouchAI-result.html');
        let attempts = 0;
        mockTauriCommand('result_export_html', () => {
            attempts += 1;
            if (attempts === 1) throw new Error('disk full');
        });

        await expect(exportMessage('Write me')).rejects.toMatchObject({
            code: 'write-failed',
        });
        await expect(exportMessage('Write me again')).resolves.toMatchObject({
            status: 'saved',
        });
        expect(getTauriInvokeCalls('result_export_html')).toHaveLength(2);
    });

    it('user is blocked from exporting high-confidence credentials', async () => {
        mockTauriCommand('plugin:dialog|save', '/tmp/TouchAI-result.html');
        mockTauriCommand('result_export_html', undefined);
        const credentials = [
            'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
            'Bearer abcdefghijklmnopqrstuvwxyz0123456789',
            'Authorization: Token abcdefghijklmnopqrstuvwxyz',
            'Cookie: session=abcdefghijklmnopqrstuvwxyz',
            'OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz123456',
        ];

        for (const credential of credentials) {
            await expect(exportMessage(`Leaked value: ${credential}`)).rejects.toMatchObject({
                code: 'sensitive-content',
            });
        }

        expect(getTauriInvokeCalls('plugin:dialog|save')).toHaveLength(0);
        expect(getTauriInvokeCalls('result_export_html')).toHaveLength(0);
    });

    it('user is blocked when a widget title contains a credential', async () => {
        mockTauriCommand('plugin:dialog|save', '/tmp/TouchAI-result.html');
        mockTauriCommand('result_export_html', undefined);
        const message = createResultExportMessage({
            parts: [{ id: 'widget-part', type: 'widget', widgetId: 'internal-widget-id' }],
            widgets: [
                {
                    ...createReadyResultWidget('<div>Safe result</div>'),
                    title: 'OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz123456',
                },
            ],
        });

        await expect(
            saveAssistantResultToFile({
                message,
                presentation: RESULT_EXPORT_TEST_PRESENTATION,
                labels: LABELS,
                now: new Date(2026, 10, 22, 9, 8, 7),
            })
        ).rejects.toMatchObject({ code: 'sensitive-content' });

        expect(getTauriInvokeCalls('plugin:dialog|save')).toHaveLength(0);
        expect(getTauriInvokeCalls('result_export_html')).toHaveLength(0);
    });

    it('user is blocked when an inlined CDN resource contains a credential', async () => {
        mockTauriCommand('plugin:dialog|save', '/tmp/TouchAI-result.html');
        mockTauriCommand('result_export_html', undefined);
        const message = createResultExportMessage({
            parts: [{ id: 'widget-part', type: 'widget', widgetId: 'internal-widget-id' }],
            widgets: [
                createReadyResultWidget(
                    '<div>Safe result</div><script src="https://cdn.jsdelivr.net/example.js"></script>'
                ),
            ],
        });

        await expect(
            saveAssistantResultToFile({
                message,
                presentation: RESULT_EXPORT_TEST_PRESENTATION,
                labels: LABELS,
                now: new Date(2026, 10, 22, 9, 8, 7),
                fetchResource: vi
                    .fn()
                    .mockResolvedValue(
                        new Response(
                            'const leaked = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";'
                        )
                    ),
            })
        ).rejects.toMatchObject({ code: 'sensitive-content' });

        expect(getTauriInvokeCalls('plugin:dialog|save')).toHaveLength(0);
        expect(getTauriInvokeCalls('result_export_html')).toHaveLength(0);
    });

    it('user is warned above four MiB and blocked above eight MiB', async () => {
        mockTauriCommand('plugin:dialog|save', '/tmp/TouchAI-result.html');
        mockTauriCommand('result_export_html', undefined);

        const warned = await exportMessage('a'.repeat(4 * 1024 * 1024 + 1));
        expect(warned.status).toBe('saved');
        if (warned.status === 'saved') {
            expect(warned.warnings).toContain('large-file');
        }

        mockTauriCommand('plugin:dialog|save', '/tmp/TouchAI-result-too-large.html');
        await expect(exportMessage('a'.repeat(MAX_RESULT_EXPORT_BYTES + 1))).rejects.toMatchObject({
            code: 'result-too-large',
        });
        expect(getTauriInvokeCalls('result_export_html')).toHaveLength(1);
    });
});
