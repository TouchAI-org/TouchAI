import { invoke } from '@services/NativeService/invoke';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { privacyFilter } from '@/services/NativeService/privacyFilter';

vi.mock('@services/NativeService/invoke', () => ({ invoke: vi.fn() }));

const mockInvoke = vi.mocked(invoke);

describe('given the user manages the local privacy detection model', () => {
    beforeEach(() => {
        mockInvoke.mockReset();
    });

    it('user gets the installed model status from the native command', async () => {
        const status = {
            installed: true,
            downloading: false,
            downloadedBytes: 38_960_842,
            totalBytes: 38_960_842,
            currentFile: null,
        };
        mockInvoke.mockResolvedValue(status);

        await expect(privacyFilter.getModelStatus()).resolves.toEqual(status);
        expect(mockInvoke).toHaveBeenCalledWith('privacy_filter_model_status', {
            modelId: 'astrlink-guard-int8',
        });
    });

    it('user starts, cancels, and deletes the local model through native commands', async () => {
        mockInvoke.mockResolvedValue(undefined);

        await privacyFilter.downloadModel('openai-privacy-filter', 'hf-mirror');
        await privacyFilter.cancelModelDownload('openai-privacy-filter');
        await privacyFilter.deleteModel('openai-privacy-filter');

        expect(mockInvoke.mock.calls).toEqual([
            [
                'privacy_filter_download_model',
                { modelId: 'openai-privacy-filter', source: 'hf-mirror' },
            ],
            ['privacy_filter_cancel_model_download', { modelId: 'openai-privacy-filter' }],
            ['privacy_filter_delete_model', { modelId: 'openai-privacy-filter' }],
        ]);
    });

    it('user records private details separately from the stored summary and retrieves them only for the selected record', async () => {
        const record = {
            mode: 'rules' as const,
            outcome: 'protected' as const,
            maskedCount: 1,
            categories: [{ kind: 'email' as const, count: 1 }],
        };
        const details = {
            values: [
                {
                    kind: 'email' as const,
                    original: 'ada@example.test',
                    placeholder: '{{EMAIL_0123456789abcdef}}',
                    count: 1,
                    matches: [{ id: 'email' as const, count: 1 }],
                },
            ],
            texts: ['Email {{EMAIL_0123456789abcdef}}'],
            truncated: false,
        };
        mockInvoke.mockResolvedValue(undefined);
        await privacyFilter.recordProtection(record, details);
        expect(mockInvoke).toHaveBeenCalledWith('privacy_filter_record_protection', {
            record,
            details,
        });
        expect(JSON.stringify(record)).not.toContain('ada@example.test');
        mockInvoke.mockResolvedValue(details);
        await expect(privacyFilter.getRecordDetails('request-1')).resolves.toEqual(details);
        expect(mockInvoke).toHaveBeenCalledWith('privacy_filter_record_details', {
            recordId: 'request-1',
        });
        mockInvoke.mockResolvedValue(null);
        await expect(privacyFilter.getRecordDetails('before-restart')).resolves.toBeNull();
    });

    it('user scans text through the native command and gets detected spans', async () => {
        const detections = [[{ start: 0, end: 15, kind: 'private_person', score: 0.95 }]];
        mockInvoke.mockResolvedValue(detections);

        await expect(privacyFilter.detect(['Morgan Lee asked'])).resolves.toEqual(detections);
        expect(mockInvoke).toHaveBeenCalledWith('privacy_filter_detect', {
            modelId: 'astrlink-guard-int8',
            texts: ['Morgan Lee asked'],
        });
    });
});
