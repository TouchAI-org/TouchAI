import { beforeEach, describe, expect, it } from 'vitest';

import { restorePrivacyChunk } from '@/adapters/models/privacy';
import { createPrivacyReview, recordPrivacyRestoration } from '@/modules/privacy';
import { PrivacyMaskingSession } from '@/modules/privacy/masking';
const review = createPrivacyReview();
const { clearPrivacyReview, privacyReviewGeneration } = review;

import { getLastTauriInvokeCall } from '../../utils/tauri';

const original = 'ada@example.test';
const placeholder = '{{EMAIL_0123456789abcdef}}';

function session() {
    const value = new PrivacyMaskingSession(privacyReviewGeneration());
    value.maskText(original, [
        { start: 0, end: original.length, kind: 'email', placeholder, rule: { id: 'email' } },
    ]);
    return value;
}

beforeEach(() => clearPrivacyReview());

describe('given a locally restored assistant response', () => {
    it('user receives a split placeholder twice when the reply completes then one reverse record contains both actual restorations and the exact returned context', async () => {
        const value = session();
        const buffers = new Map<string, string>();
        restorePrivacyChunk(
            { content: `Contact ${placeholder.slice(0, 10)}`, done: false },
            value,
            buffers
        );
        restorePrivacyChunk(
            { content: `${placeholder.slice(10)} and ${placeholder}.`, done: true },
            value,
            buffers
        );
        await recordPrivacyRestoration(value, { sessionId: 7, modelName: 'Kimi K2' });
        expect(getLastTauriInvokeCall('privacy_filter_record_restoration')?.payload).toEqual({
            record: {
                mode: 'rules',
                outcome: 'protected',
                maskedCount: 2,
                categories: [{ kind: 'email', count: 2 }],
                sessionId: 7,
                modelName: 'Kimi K2',
            },
            details: {
                values: [
                    {
                        original,
                        placeholder,
                        kind: 'email',
                        count: 2,
                        matches: [{ id: 'email', count: 2 }],
                    },
                ],
                texts: [`Contact ${placeholder} and ${placeholder}.`],
                truncated: false,
            },
        });
    });

    it('user receives a direct original and an incomplete placeholder when the stream ends then no reverse record is fabricated', async () => {
        const value = session();
        restorePrivacyChunk(
            { content: `${original} ${placeholder.slice(0, 10)}`, done: true },
            value,
            new Map()
        );
        await recordPrivacyRestoration(value, undefined, privacyReviewGeneration());
        expect(getLastTauriInvokeCall('privacy_filter_record_restoration')).toBeUndefined();
    });

    it('user clears review while a response streams when it later completes then the old response cannot recreate a reverse record', async () => {
        const value = session();
        restorePrivacyChunk({ content: placeholder, done: true }, value, new Map());
        clearPrivacyReview();
        await recordPrivacyRestoration(value, undefined, privacyReviewGeneration());
        expect(getLastTauriInvokeCall('privacy_filter_record_restoration')).toBeUndefined();
    });
});
