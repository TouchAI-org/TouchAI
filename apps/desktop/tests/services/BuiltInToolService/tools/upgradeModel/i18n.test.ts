import { toolMessages } from '@tests/utils/toolMessages';
import { createToolsHostFixture } from '@tests/utils/toolsHost';
import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { createUpgradeModelConfiguration, createUpgradeModelTools } from '@/modules/tools';

afterEach(() => setLocale('zh-CN'));

async function prepared(chain: { providerId: number; modelId: string }[]) {
    const fixture = await createToolsHostFixture();
    const config = { chain };
    const descriptor = createUpgradeModelTools({
        messages: toolMessages,
        models: {
            resolve: fixture.bindings.resolveTarget,
            isAvailable: fixture.bindings.isAvailable,
            complete: fixture.bindings.complete,
        },
    })[0]!;
    const tool = await descriptor.prepareForTurn(config, {
        taskId: fixture.taskId,
        currentModel: fixture.currentModel,
    });
    return { ...fixture, config, tool, context: { callId: 'upgrade-call', iteration: 1 } };
}

describe('given a saved current model and upgrade chain', () => {
    it('user reads the approval in English when a configured target is available', async () => {
        setLocale('en-US');
        const input = await prepared([
            { providerId: 1, modelId: 'model-a' },
            { providerId: 2, modelId: 'model-b' },
        ]);
        expect(
            await input.tool.buildApprovalRequest(
                {},
                input.config,
                'builtin__upgrade_model',
                input.context
            )
        ).toMatchObject({
            title: 'Confirm model switch',
            description: 'Allow switching from Provider A / Model A to Provider B / Model B',
            command: 'Provider A / Model A -> Provider B / Model B',
            reason: 'This changes the model used by the current conversation and also affects the subsequent default model.',
            approveLabel: 'Approve',
            rejectLabel: 'Reject',
        });
    });

    it('user reads the successful result in English with the captured model switch', async () => {
        setLocale('en-US');
        const input = await prepared([{ providerId: 2, modelId: 'model-b' }]);
        const result = await input.tool.execute({}, input.config, input.context);
        expect(result).toMatchObject({
            isError: false,
            status: 'success',
            controlSignal: {
                type: 'upgrade_model',
                targetModel: { id: 20, provider_id: 2, model_id: 'model-b' },
                restartCurrentRequest: false,
            },
        });
        expect(result.result).toContain('Model upgraded');
        expect(result.result).toContain('Target model: Provider B / Model B');
        expect(result.result).toContain(
            'The system will switch directly to the new model and continue the conversation with the current context.'
        );
    });

    it('user reads an English failure and retains the current model when no target is configured', async () => {
        setLocale('en-US');
        const input = await prepared([]);
        const result = await input.tool.execute({}, input.config, input.context);
        expect(result).toMatchObject({
            isError: true,
            status: 'error',
            errorMessage: 'Configure the model upgrade chain in UpgradeModel settings first.',
        });
        expect(result.result).toContain('Model upgrade failed');
        expect(result.result).toContain('Current model: Provider A / Model A');
        expect(result.result).toContain('Upgrade chain: Not configured');
        expect(result.controlSignal).toBeUndefined();
        expect(input.database.prepare('SELECT id FROM models WHERE is_default = 1').all()).toEqual([
            { id: 10 },
        ]);
    });

    it('user reads English validation errors when the saved upgrade chain is malformed', () => {
        setLocale('en-US');
        const configuration = createUpgradeModelConfiguration(toolMessages);
        expect(() => configuration.normalizeEntry({ providerId: 1, modelId: '' })).toThrow(
            'Each model upgrade chain item must include providerId and a non-empty modelId.'
        );
        for (const value of [
            'not-json',
            '{"providerId":1,"modelId":"model-a"}',
            { providerId: 1, modelId: 'model-a' },
        ]) {
            expect(() => configuration.normalizeChain(value)).toThrow(
                'The model upgrade chain must be an array or a JSON string that parses to an array.'
            );
        }
        expect(() => configuration.normalizeChain([{ providerId: 1, modelId: '' }])).toThrow(
            'Each model upgrade chain item must include providerId and a non-empty modelId.'
        );
    });
});
