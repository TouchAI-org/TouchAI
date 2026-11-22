import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';

import {
    ExternalAgentCommandError,
    type ExternalAgentsAdministrationApi,
    externalAgentsAdministrationApiKey,
    useExternalAgentsAdministrationApi,
} from '@/app/api/tools/externalAgents';

afterEach(() => {
    vi.restoreAllMocks();
});

const api = {
    add: vi.fn(),
    delete: vi.fn(),
    findAll: vi.fn(),
    rediscover: vi.fn(),
    updateEnabled: vi.fn(),
} satisfies ExternalAgentsAdministrationApi;

describe('given the external agent settings boundary', () => {
    it('user sees external agent management available when settings provides it', () => {
        const app = createApp({});
        app.provide(externalAgentsAdministrationApiKey, api);

        expect(app.runWithContext(useExternalAgentsAdministrationApi)).toBe(api);
    });

    it('user sees a stable unavailable error when settings is not provided', () => {
        const app = createApp({});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        let thrown: unknown;

        try {
            app.runWithContext(useExternalAgentsAdministrationApi);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toMatchObject({
            name: 'ExternalAgentCommandError',
            code: 'EXTERNAL_AGENT_COMMAND_UNAVAILABLE',
            outcome: 'none',
        });
        expect(warn).toHaveBeenCalled();
    });

    it('user sees command failure details preserved for settings handling', () => {
        const error = new ExternalAgentCommandError(
            'EXTERNAL_AGENT_COMMAND_UNCONFIRMED',
            'unknown'
        );

        expect(error).toMatchObject({
            name: 'ExternalAgentCommandError',
            message: 'EXTERNAL_AGENT_COMMAND_UNCONFIRMED',
            code: 'EXTERNAL_AGENT_COMMAND_UNCONFIRMED',
            outcome: 'unknown',
        });
    });
});
