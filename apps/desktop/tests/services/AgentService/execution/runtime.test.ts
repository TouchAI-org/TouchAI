import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import { AiConversationRuntime } from '@/services/AgentService/execution/runtime';

const authServiceMock = vi.hoisted(() => ({
    invalidateManagedAuthForError: vi.fn(),
}));

vi.mock('@/services/AuthService', () => ({
    invalidateManagedAuthForError: authServiceMock.invalidateManagedAuthForError,
}));

function createManagedMimoModel() {
    return {
        provider_id: 12,
        provider_driver: 'mimo',
        api_endpoint: 'https://hub.touch-ai.org/api/v1',
        provider_config_json: JSON.stringify({
            touchAiMode: 'managed',
            managedAuth: { login: 'user' },
        }),
    };
}

describe('AiConversationRuntime managed auth invalidation', () => {
    beforeEach(() => {
        authServiceMock.invalidateManagedAuthForError.mockReset();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('keeps the original request error when managed auth cleanup fails', async () => {
        const runtime = new AiConversationRuntime(
            {} as ConstructorParameters<typeof AiConversationRuntime>[0],
            {
                prompt: 'hello',
            }
        );
        const requestError = new AiError(
            AiErrorCode.UNAUTHORIZED,
            {
                gatewayCode: 'invalid_or_revoked_api_key',
                requiresRelogin: true,
                statusCode: 401,
            },
            'invalid_or_revoked_api_key'
        );
        const cleanupError = new TypeError('n is not a function');

        authServiceMock.invalidateManagedAuthForError.mockRejectedValue(cleanupError);

        await expect(
            (
                runtime as unknown as {
                    invalidateManagedAuthIfNeeded: (
                        model: ReturnType<typeof createManagedMimoModel>,
                        error: AiError
                    ) => Promise<boolean>;
                }
            ).invalidateManagedAuthIfNeeded(createManagedMimoModel(), requestError)
        ).resolves.toBe(false);

        expect(authServiceMock.invalidateManagedAuthForError).toHaveBeenCalledWith({
            providerId: 12,
            error: requestError,
        });
        expect(console.warn).toHaveBeenCalledWith(
            '[AiConversationRuntime] Failed to invalidate managed auth after request failure:',
            cleanupError
        );
    });
});
