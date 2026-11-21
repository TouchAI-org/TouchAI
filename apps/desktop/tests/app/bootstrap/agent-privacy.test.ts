import { webcrypto } from 'node:crypto';

import {
    createAgentWindowFixture,
    network,
    responseFromDeltas,
    streamingResponse,
} from '@tests/utils/agentWindow';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Install the fixture's system-boundary mocks before loading the lazy host graph.
await import('@/app/composition/main');

import { hashPrivacyText } from '@/app/api/privacy';
import { setLocale } from '@/i18n';

const original = 'ada@example.test';
const owned: Array<ReturnType<typeof createAgentWindowFixture>['window']> = [];
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(async () => {
    for (const window of owned.splice(0)) await window.dispose();
    vi.unstubAllGlobals();
});

async function protectedWindow() {
    let generation = 0;
    mockTauriCommand('privacy_filter_record_generation', () => generation);
    mockTauriCommand('privacy_filter_clear_records', () => ++generation);
    const fixture = createAgentWindowFixture();
    owned.push(fixture.window);
    await fixture.window.settings.initialize();
    await fixture.window.privacy.updatePrivacyFilterSettings({
        ...fixture.window.privacy.getPrivacyFilterSettings(),
        enabled: true,
        useLocalModel: false,
    });
    mockTauriCommand('privacy_filter_record_protection', undefined);
    mockTauriCommand('privacy_filter_record_restoration', undefined);
    return fixture;
}

function sentPlaceholder(body: unknown) {
    const text = JSON.stringify(body);
    expect(text).not.toContain(original);
    const placeholder = text.match(/\{\{EMAIL_[0-9a-f]{16}\}\}/)?.[0];
    expect(placeholder).toBeDefined();
    return placeholder!;
}

describe('given the production main host owns privacy and Core sees only neutral messages', () => {
    it('user sends with an unavailable local model and blocking selected then sees a failed conversation and the provider gets nothing', async () => {
        const fixture = await protectedWindow();
        setLocale('en-US');
        await fixture.window.privacy.updatePrivacyFilterSettings({
            ...fixture.window.privacy.getPrivacyFilterSettings(),
            useLocalModel: true,
        });
        await fixture.window.privacy.updatePrivacyFilterFailureAction('block');
        mockTauriCommand('privacy_filter_model_status', { installed: false });
        network.replies.push(responseFromDeltas([{ content: 'Unexpected provider reply' }]));

        const started = await fixture.window.api.startTask({ prompt: original });

        await expect(started.completion).rejects.toMatchObject({
            code: 'PRIVACY_FILTER_BLOCKED',
        });
        const snapshot = fixture.window.api.getTaskSnapshot(started.taskId)!;
        expect(snapshot.status).toBe('failed');
        expect(snapshot.sessionHistory).toContainEqual(
            expect.objectContaining({ role: 'user', content: original })
        );
        expect(snapshot.sessionHistory).toContainEqual(
            expect.objectContaining({
                isError: true,
                content: expect.stringContaining('Masking failed and your message was not sent.'),
            })
        );
        expect(network.requests).toHaveLength(0);
        expect(getTauriInvokeCalls('privacy_filter_record_protection')).toEqual([
            expect.objectContaining({
                payload: expect.objectContaining({
                    record: expect.objectContaining({
                        outcome: 'blocked',
                        mode: 'model',
                        maskedCount: 0,
                        sessionId: snapshot.sessionId,
                    }),
                }),
            }),
        ]);
    });

    it('user sends sensitive text then the provider receives a placeholder and the locally restored reply has exact message and part annotations', async () => {
        const fixture = await protectedWindow();
        network.respondToGeneration = async (_url, init) => {
            const placeholder = sentPlaceholder(JSON.parse(String(init.body)));
            return responseFromDeltas([
                { content: `Contact ${placeholder.slice(0, 9)}` },
                { content: `${placeholder.slice(9)}.` },
            ]);
        };
        const prompt = `Please email ${original}.`;
        const started = await fixture.window.api.startTask({ prompt });
        const result = await started.completion;
        expect(result.response).toBe(`Contact ${original}.`);
        const snapshot = fixture.window.api.getTaskSnapshot(started.taskId)!;
        const user = snapshot.sessionHistory.find((message) => message.role === 'user')!;
        const reply = snapshot.sessionHistory
            .flatMap((message) => message.parts)
            .find((part) => part.type === 'text')!;
        expect(user.content).toBe(prompt);
        expect(user.sourceMessageId).toBeGreaterThan(0);
        expect(
            fixture.window.privacy.selectPrivacyAnnotations(
                user.sourceMessageId,
                prompt,
                await hashPrivacyText(prompt)
            )
        ).toHaveLength(1);
        expect(
            fixture.window.privacy.selectRestoredPrivacyAnnotations(
                reply.id,
                `Contact ${original}.`
            )
        ).toEqual([expect.objectContaining({ original, rule: { id: 'email' } })]);
        expect(getTauriInvokeCalls('privacy_filter_record_protection')).toHaveLength(1);
        expect(getTauriInvokeCalls('privacy_filter_record_restoration')).toHaveLength(1);
    });

    it('user steers a running request with sensitive text then the delivered queue message keeps its persisted identity and receives protection annotations', async () => {
        const fixture = await protectedWindow();
        const first = streamingResponse();
        let requests = 0;
        network.respondToGeneration = async (_url, init) => {
            if (requests++ === 0) return first.response;
            const placeholder = sentPlaceholder(JSON.parse(String(init.body)));
            return responseFromDeltas([{ content: placeholder }]);
        };
        const started = await fixture.window.api.startTask({ prompt: 'Start' });
        await vi.waitFor(() => expect(network.requests).toHaveLength(1));
        first.delta({ content: 'Ready' });
        const pending = fixture.window.api.enqueueTaskUserMessage(
            started.taskId,
            { prompt: original },
            'queue'
        )!;
        expect(fixture.window.api.promoteTaskUserMessage(started.taskId, pending.id)).toBe(true);
        first.delta({ content: ' to continue' });
        first.finish();
        await started.completion;
        const snapshot = fixture.window.api.getTaskSnapshot(started.taskId)!;
        const delivered = snapshot.sessionHistory.find((message) => message.id === pending.id)!;
        expect(delivered.content).toBe(original);
        expect(delivered.sourceMessageId).toBeGreaterThan(0);
        expect(
            fixture.window.privacy.selectPrivacyAnnotations(
                delivered.sourceMessageId,
                original,
                await hashPrivacyText(original)
            )
        ).toHaveLength(1);
        expect(network.requests).toHaveLength(2);
    });

    it('user clears records during a split reply then the active reply still restores while late annotations and reverse records stay cleared', async () => {
        const fixture = await protectedWindow();
        const stream = streamingResponse();
        network.replies.push(stream.response);
        const started = await fixture.window.api.startTask({ prompt: original });
        await vi.waitFor(() => expect(network.requests).toHaveLength(1));
        const placeholder = sentPlaceholder(network.requests[0]);
        stream.delta({ content: placeholder.slice(0, 9) });
        await vi.waitFor(() =>
            expect(fixture.window.privacy.getReviewSnapshot().annotations.length).toBeGreaterThan(0)
        );
        await fixture.window.privacy.clearRecords();
        stream.delta({ content: placeholder.slice(9) });
        stream.finish();
        expect((await started.completion).response).toBe(original);
        expect(fixture.window.privacy.getReviewSnapshot().annotations).toEqual([]);
        expect(getTauriInvokeCalls('privacy_filter_record_restoration')).toHaveLength(0);
    });
});
