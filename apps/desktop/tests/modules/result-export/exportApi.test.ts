import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS } from '@/app/api/tools/widgets';
import { setLocale, t } from '@/i18n';
import type { ResultExportMessage } from '@/modules/result-export/public';
import { ResultExportError } from '@/modules/result-export/types';

import {
    createResultExportMessage,
    RESULT_EXPORT_TEST_PRESENTATION,
} from '../../utils/resultExport';

const prepareResultExportMock = vi.hoisted(() => vi.fn());
const tauriFetch = vi.hoisted(() => vi.fn());
const createTauriFetchMock = vi.hoisted(() => vi.fn(() => tauriFetch));
const saveMock = vi.hoisted(() => vi.fn());
const writeHtmlMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());

vi.mock('@/modules/result-export/public', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/modules/result-export/public')>();
    return { ...actual, prepareResultExport: prepareResultExportMock };
});
vi.mock('@/platform/files/dialogs', () => ({ save: saveMock }));
vi.mock('@/platform/native/resultExport', () => ({
    resultExport: { writeHtml: writeHtmlMock },
}));
vi.mock('@/platform/http', () => ({ createTauriFetch: createTauriFetchMock }));
vi.mock('@/app/api/windows/notifications', () => ({ notify: notifyMock }));
vi.mock('@/app/api/diagnostics', () => ({ log: { error: logErrorMock } }));

const { exportAssistantResult, saveAssistantResultToFile } =
    await import('@/app/api/agent/resultExport');

const LABELS = {
    dialogTitle: 'Save result',
    filterName: 'HTML result',
};
const NOW = new Date(2026, 10, 22, 9, 8, 7);
const EXPORTED_DOCUMENT = {
    html: '<!doctype html><html><body>Saved result</body></html>',
    bytes: 57,
    warnings: [],
};

function message(content = 'Saved result'): ResultExportMessage {
    return createResultExportMessage({
        parts: [{ id: 'text-1', type: 'text', content }],
    });
}

function saveResult(overrides: Partial<Parameters<typeof saveAssistantResultToFile>[0]> = {}) {
    return saveAssistantResultToFile({
        message: message(),
        presentation: RESULT_EXPORT_TEST_PRESENTATION,
        labels: LABELS,
        now: NOW,
        ...overrides,
    });
}

beforeEach(() => {
    setLocale('en-US');
    prepareResultExportMock.mockReset();
    prepareResultExportMock.mockResolvedValue(EXPORTED_DOCUMENT);
    tauriFetch.mockReset();
    createTauriFetchMock.mockClear();
    saveMock.mockReset();
    saveMock.mockResolvedValue('/tmp/TouchAI-result');
    writeHtmlMock.mockReset();
    writeHtmlMock.mockResolvedValue(undefined);
    notifyMock.mockClear();
    logErrorMock.mockClear();
});

describe('user saves or reports the outcome of a completed result', () => {
    it('user saves the generated document with an HTML extension', async () => {
        const result = await saveResult();

        expect(result).toEqual({ status: 'saved', warnings: [] });
        expect(saveMock).toHaveBeenCalledWith({
            title: 'Save result',
            defaultPath: 'TouchAI-result-20261122-090807.html',
            filters: [{ name: 'HTML result', extensions: ['html'] }],
        });
        expect(writeHtmlMock).toHaveBeenCalledWith(
            '/tmp/TouchAI-result.html',
            EXPORTED_DOCUMENT.html
        );
        expect(prepareResultExportMock.mock.calls[0]?.[0].presentation.allowedResourceHosts).toBe(
            SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS
        );
    });

    it('user keeps an HTML extension that is already present', async () => {
        saveMock.mockResolvedValue('/tmp/TouchAI-result.HTML');

        await saveResult();

        expect(writeHtmlMock).toHaveBeenCalledWith(
            '/tmp/TouchAI-result.HTML',
            EXPORTED_DOCUMENT.html
        );
    });

    it('user cancels before any document is written', async () => {
        saveMock.mockResolvedValue(null);

        await expect(saveResult()).resolves.toEqual({ status: 'cancelled' });
        expect(writeHtmlMock).not.toHaveBeenCalled();
    });

    it('user gets a dialog error for thrown errors and non-errors', async () => {
        saveMock.mockRejectedValueOnce(new Error('dialog exploded'));
        saveMock.mockRejectedValueOnce('dialog unavailable');

        await expect(saveResult()).rejects.toMatchObject({
            code: 'dialog-failed',
            message: 'dialog exploded',
        });
        await expect(saveResult()).rejects.toMatchObject({
            code: 'dialog-failed',
            message: 'Could not open the save dialog.',
        });
        expect(writeHtmlMock).not.toHaveBeenCalled();
    });

    it('user gets a write error for thrown errors and non-errors', async () => {
        writeHtmlMock.mockRejectedValueOnce(new Error('disk full'));
        writeHtmlMock.mockRejectedValueOnce('permission denied');

        await expect(saveResult()).rejects.toMatchObject({
            code: 'write-failed',
            message: 'disk full',
        });
        await expect(saveResult()).rejects.toMatchObject({
            code: 'write-failed',
            message: 'Could not write the result file.',
        });
    });

    it('user gets the matching notification for every successful save variant', async () => {
        prepareResultExportMock
            .mockResolvedValueOnce({ ...EXPORTED_DOCUMENT, warnings: [] })
            .mockResolvedValueOnce({
                ...EXPORTED_DOCUMENT,
                warnings: ['online-resources'],
            })
            .mockResolvedValueOnce({ ...EXPORTED_DOCUMENT, warnings: ['large-file'] })
            .mockResolvedValueOnce({
                ...EXPORTED_DOCUMENT,
                warnings: ['large-file', 'online-resources'],
            });

        await exportAssistantResult(message(), RESULT_EXPORT_TEST_PRESENTATION);
        await exportAssistantResult(message(), RESULT_EXPORT_TEST_PRESENTATION);
        await exportAssistantResult(message(), RESULT_EXPORT_TEST_PRESENTATION);
        await exportAssistantResult(message(), RESULT_EXPORT_TEST_PRESENTATION);

        expect(notifyMock.mock.calls.map(([notification]) => notification.body)).toEqual([
            t('assistant.resultExport.saved'),
            t('assistant.resultExport.savedWithOnlineResources'),
            t('assistant.resultExport.savedLarge'),
            t('assistant.resultExport.savedLargeWithOnlineResources'),
        ]);
        expect(createTauriFetchMock).toHaveBeenCalledTimes(4);
        expect(prepareResultExportMock.mock.calls[0]?.[0].fetchResource).toBe(tauriFetch);
    });

    it('user gets no notification after cancelling the save dialog', async () => {
        saveMock.mockResolvedValue(null);

        await exportAssistantResult(message(), RESULT_EXPORT_TEST_PRESENTATION);

        expect(notifyMock).not.toHaveBeenCalled();
    });

    it('user gets a specific message for blocked or oversized results', async () => {
        prepareResultExportMock
            .mockRejectedValueOnce(
                new ResultExportError('sensitive-content', 'Sensitive credentials')
            )
            .mockRejectedValueOnce(
                new ResultExportError('result-too-large', 'Result exceeds the limit')
            )
            .mockRejectedValueOnce(
                new ResultExportError('dialog-failed', 'Could not open the dialog')
            );

        await exportAssistantResult(message(), RESULT_EXPORT_TEST_PRESENTATION);
        await exportAssistantResult(message(), RESULT_EXPORT_TEST_PRESENTATION);
        await exportAssistantResult(message(), RESULT_EXPORT_TEST_PRESENTATION);

        expect(notifyMock.mock.calls.map(([notification]) => notification.body)).toEqual([
            t('assistant.resultExport.sensitiveBlocked'),
            t('assistant.resultExport.tooLarge'),
            t('assistant.resultExport.failed'),
        ]);
    });

    it('user gets a logged failure when the export throws unexpectedly', async () => {
        const error = new Error('unexpected failure');
        prepareResultExportMock.mockRejectedValueOnce(error);

        await exportAssistantResult(message(), RESULT_EXPORT_TEST_PRESENTATION);

        expect(logErrorMock).toHaveBeenCalledWith('[resultExport] Failed to export result:', error);
        expect(notifyMock).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: t('assistant.resultExport.failed'),
        });
    });
});
