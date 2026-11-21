import { AgentError } from '@touchai/agent-core/contracts';
import type { AiStreamChunk } from '@touchai/models/contracts';

import type { DesktopModelRequest } from '@/adapters/models/input';
import {
    maskDesktopModelMessages,
    prepareUnmaskedPrivacyReplay,
    PrivacyReplayError,
    restorePrivacyChunk,
} from '@/adapters/models/privacy';
import { AiErrorCode } from '@/app/api/agent/errors';
import type { PrivacySettingsApi } from '@/app/api/privacy';
import {
    getPrivacyRecordGeneration,
    PrivacyMaskingSession,
    type PrivacyReview,
    recordPrivacyProtection,
    recordPrivacyRestoration,
} from '@/modules/privacy';
import type { PrivacyRestoredSpan } from '@/modules/privacy/public';
import { log } from '@/platform/diagnostics';
import { awaitAbortable } from '@/utils/abort';

export function createDesktopPrivacyStream(input: {
    settings: PrivacySettingsApi;
    review: Pick<PrivacyReview, 'privacyReviewGeneration' | 'publishPrivacyReview'>;
    context(): { sessionId?: number; modelName?: string };
    restored(content: string, spans: PrivacyRestoredSpan[], generation: number): void;
}) {
    return async function* (
        request: DesktopModelRequest,
        send: (request: DesktopModelRequest) => AsyncIterable<AiStreamChunk>
    ): AsyncGenerator<AiStreamChunk> {
        const signal = request.signal;
        signal?.throwIfAborted();
        await awaitAbortable(input.settings.initialize, signal);
        signal?.throwIfAborted();
        const settings = input.settings.getPrivacyFilterSettings();
        if (!settings.enabled) {
            yield* send(request);
            return;
        }
        const generation = input.review.privacyReviewGeneration();
        const recordGeneration = await awaitAbortable(getPrivacyRecordGeneration, signal);
        const modelId = input.settings.getPrivacyFilterModelId();
        const prepare = (configuration = settings) =>
            awaitAbortable(
                () =>
                    maskDesktopModelMessages(
                        request.messages,
                        configuration,
                        modelId,
                        generation,
                        recordGeneration
                    ),
                signal
            );
        let masked: Awaited<ReturnType<typeof maskDesktopModelMessages>> | undefined;
        try {
            masked = await prepare();
        } catch (error) {
            signal?.throwIfAborted();
            let unsafeReplay = error instanceof PrivacyReplayError;
            const action =
                settings.useLocalModel && !(error instanceof PrivacyReplayError)
                    ? input.settings.getPrivacyFilterFailureAction()
                    : 'block';
            if (action === 'send-original') {
                let messages: DesktopModelRequest['messages'] | undefined;
                try {
                    messages = prepareUnmaskedPrivacyReplay(request.messages);
                } catch (replayError) {
                    if (!(replayError instanceof PrivacyReplayError)) throw replayError;
                    unsafeReplay = true;
                }
                if (messages) {
                    log.warn('[PrivacyProtection] Masking failed; sending original by preference');
                    yield* send({ ...request, messages });
                    return;
                }
            }
            let mode: 'model' | 'rules' = settings.useLocalModel ? 'model' : 'rules';
            if (action === 'fallback-rules') {
                mode = 'rules';
                log.warn('[PrivacyProtection] Masking failed; falling back to rules');
                try {
                    masked = await prepare({ ...settings, useLocalModel: false });
                } catch (fallbackError) {
                    unsafeReplay = fallbackError instanceof PrivacyReplayError;
                    signal?.throwIfAborted();
                }
            }
            if (!masked) {
                log.warn('[PrivacyProtection] Masking failed; request blocked', { mode });
                await recordPrivacyProtection(
                    new PrivacyMaskingSession(generation, recordGeneration),
                    'blocked',
                    mode,
                    input.context(),
                    input.review.privacyReviewGeneration()
                );
                signal?.throwIfAborted();
                throw new AgentError(
                    unsafeReplay
                        ? AiErrorCode.PRIVACY_REPLAY_BLOCKED
                        : AiErrorCode.PRIVACY_FILTER_BLOCKED
                );
            }
        }
        signal?.throwIfAborted();
        const { session } = masked;
        const buffers = new Map<string, string>();
        let sent = false;
        try {
            for await (const chunk of send({ ...request, messages: masked.messages })) {
                signal?.throwIfAborted();
                if (!sent) {
                    sent = true;
                    input.review.publishPrivacyReview(masked.annotations, generation);
                    await recordPrivacyProtection(
                        session,
                        'protected',
                        session.mode,
                        input.context(),
                        input.review.privacyReviewGeneration()
                    );
                    signal?.throwIfAborted();
                }
                const restored = restorePrivacyChunk(chunk, session, buffers);
                if (restored.privacyRestoration)
                    input.restored(restored.content, restored.privacyRestoration.spans, generation);
                delete restored.privacyRestoration;
                yield restored;
            }
        } finally {
            buffers.clear();
            if (sent)
                await recordPrivacyRestoration(
                    session,
                    input.context(),
                    input.review.privacyReviewGeneration()
                );
        }
    };
}
