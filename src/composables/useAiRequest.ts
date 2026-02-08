// Copyright (c) 2025. 千诚. Licensed under GPL v3

import { createAiRequest, updateAiRequest } from '@database/queries';
import type { AiRequest } from '@database/schema';
import { aiService } from '@services/ai/manager';
import { sendNotification } from '@tauri-apps/plugin-notification';
import type { Attachment } from '@utils/attachment';
import { computed, ref } from 'vue';

export interface UseAiRequestOptions {
    sessionId?: number;
    onChunk?: (content: string) => void;
    onComplete?: (response: string) => void;
    onError?: (error: Error) => void;
}

export function useAiRequest(options: UseAiRequestOptions = {}) {
    const isLoading = ref(false);
    const error = ref<Error | null>(null);
    const response = ref('');
    const reasoning = ref(''); // 推理内容
    const currentRequest = ref<AiRequest | null>(null);
    const abortController = ref<AbortController | null>(null);

    const hasError = computed(() => error.value !== null);
    const hasResponse = computed(() => response.value.length > 0);

    async function sendRequest(
        prompt: string,
        modelIdOverride?: string,
        providerIdOverride?: number,
        attachments: Attachment[] = []
    ) {
        if (!prompt.trim()) {
            console.error('[useAiRequest] Empty prompt provided');
            error.value = new Error('Prompt cannot be empty');
            return;
        }

        // 创建新的 AbortController
        abortController.value = new AbortController();
        const signal = abortController.value.signal;

        isLoading.value = true;
        error.value = null;
        response.value = '';
        reasoning.value = '';

        const startTime = Date.now();

        try {
            // 获取模型（覆盖或默认）
            let model;
            if (modelIdOverride && providerIdOverride) {
                model = await aiService.getModelByProviderAndModelId(
                    providerIdOverride,
                    modelIdOverride
                );
            } else {
                model = await aiService.getActiveModel();
            }

            if (!model) {
                console.error('[useAiRequest] No active model found');
                throw new Error('未设置默认模型，请在设置中心中选择一个模型');
            }

            currentRequest.value = await createAiRequest({
                session_id: options.sessionId || null,
                model_id: model.id,
                prompt,
                status: 'streaming',
            });

            const stream = aiService.stream(
                prompt,
                options.sessionId,
                modelIdOverride,
                providerIdOverride,
                attachments
            );

            for await (const { chunk } of stream) {
                // 检查是否已被取消
                if (signal.aborted) {
                    throw new Error('Request cancelled');
                }

                if (chunk.reasoning) {
                    reasoning.value += chunk.reasoning;
                }

                if (chunk.content) {
                    response.value += chunk.content;
                    options.onChunk?.(chunk.content);
                }

                if (chunk.done) {
                    break;
                }
            }

            // 再次检查是否已被取消
            if (signal.aborted) {
                throw new Error('Request cancelled');
            }

            const duration = Date.now() - startTime;

            // 检查是否为空回复
            if (!response.value.trim()) {
                console.warn('[useAiRequest] Model returned empty response');

                // 发送系统通知
                try {
                    sendNotification({
                        title: 'TouchAI - 空回复',
                        body: '模型返回了空回复，请尝试重新提问或更换模型',
                    });
                } catch (notificationError) {
                    console.error('[useAiRequest] Failed to send notification:', notificationError);
                }
            }

            await updateAiRequest(currentRequest.value.id, {
                response: response.value,
                status: 'completed',
                duration_ms: duration,
            });

            options.onComplete?.(response.value);
        } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));

            // 如果是取消操作，不显示错误
            if (err.message === 'Request cancelled') {
                if (currentRequest.value) {
                    await updateAiRequest(currentRequest.value.id, {
                        status: 'cancelled',
                        error_message: 'Cancelled by user',
                    });
                }
                return;
            }

            console.error('[useAiRequest] Request failed:', err.message);
            error.value = err;

            if (currentRequest.value) {
                await updateAiRequest(currentRequest.value.id, {
                    status: 'failed',
                    error_message: err.message,
                });
            }

            // 发送系统通知
            try {
                sendNotification({
                    title: 'TouchAI - 请求失败',
                    body: err.message || '未知错误',
                });
            } catch (notificationError) {
                console.error('[useAiRequest] Failed to send notification:', notificationError);
            }

            options.onError?.(err);
        } finally {
            isLoading.value = false;
        }
    }

    function reset() {
        isLoading.value = false;
        error.value = null;
        response.value = '';
        reasoning.value = '';
        currentRequest.value = null;
        abortController.value = null;
    }

    function cancel() {
        if (abortController.value) {
            abortController.value.abort();
            reset();
        }
    }

    return {
        isLoading,
        error,
        response,
        reasoning,
        hasError,
        hasResponse,
        sendRequest,
        reset,
        cancel,
    };
}
