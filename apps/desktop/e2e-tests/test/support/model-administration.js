import {
    callE2eBridge,
    switchToWindowContaining,
    switchToWindowWithE2eBridge,
    waitForTestIdDisplayed,
} from './desktop.js';

/** Configure fixtures through the same Settings-to-main owner channel as the UI. */
export async function requestModelAdministration(command) {
    return browser.execute(async (operation) => {
        const internals = window.__TAURI_INTERNALS__;
        if (internals?.metadata?.currentWindow?.label !== 'settings') {
            throw new Error('Model administration requests must originate in Settings.');
        }
        const requestId = crypto.randomUUID();
        const event = 'models:administration:reply';
        let settle;
        const completion = new Promise((resolve) => {
            settle = resolve;
        });
        const callbackId = internals.transformCallback(({ payload }) => {
            if (payload?.requestId === requestId) settle(payload);
        });
        let eventId;
        let timer;
        try {
            eventId = await internals.invoke('plugin:event|listen', {
                event,
                target: { kind: 'Window', label: 'settings' },
                handler: callbackId,
            });
            timer = setTimeout(() => settle(null), 10_000);
            await internals.invoke('plugin:event|emit_to', {
                target: { kind: 'AnyLabel', label: 'main' },
                event: 'models:administration:request',
                payload: { requestId, from: 'settings', command: operation },
            });
            const reply = await completion;
            if (reply === null)
                throw new Error('Main did not confirm the model command within 10s.');
            if (reply.ok !== true) {
                throw new Error(`Model administration failed: ${reply.code} (${reply.outcome}).`);
            }
            return reply.result;
        } finally {
            clearTimeout(timer);
            try {
                if (eventId !== undefined) {
                    window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, eventId);
                    await internals.invoke('plugin:event|unlisten', { event, eventId });
                }
            } finally {
                internals.unregisterCallback(callbackId);
            }
        }
    }, command);
}

export async function configureE2eModel(endpoint, modelId, modelName) {
    const mainHandle = await browser.getWindowHandle();
    let settingsHandle;
    try {
        await callE2eBridge('openSettingsWindow');
        settingsHandle = await switchToWindowContaining('/settings');
        await waitForTestIdDisplayed('settings-nav-general');
        const models = await requestModelAdministration({ operation: 'models' });
        const providerName = 'TouchAI E2E Local';
        const existingProvider = models.find((model) => model.provider_name === providerName);
        const providerPatch = {
            driver: 'openai-compatible',
            api_endpoint: endpoint,
            enabled: 1,
        };
        let providerId = existingProvider?.provider_id;
        if (providerId === undefined) {
            const provider = await requestModelAdministration({
                operation: 'provider-create',
                data: {
                    name: providerName,
                    ...providerPatch,
                    is_builtin: 0,
                    api_key: null,
                    config_json: null,
                    logo: 'openai.png',
                },
            });
            providerId = provider.id;
        } else {
            await requestModelAdministration({
                operation: 'provider-update',
                id: providerId,
                patch: providerPatch,
            });
        }
        const modelPatch = {
            name: modelName,
            tool_call: 1,
            context_limit: 65_536,
            output_limit: 8_192,
        };
        let modelDbId = models.find(
            (model) => model.provider_id === providerId && model.model_id === modelId
        )?.id;
        if (modelDbId === undefined) {
            const model = await requestModelAdministration({
                operation: 'model-create',
                data: { provider_id: providerId, model_id: modelId, ...modelPatch },
            });
            modelDbId = model.id;
        } else {
            await requestModelAdministration({
                operation: 'model-update',
                id: modelDbId,
                patch: modelPatch,
            });
        }
        await requestModelAdministration({ operation: 'set-default', id: modelDbId });
    } finally {
        try {
            if (settingsHandle) {
                await browser.switchToWindow(settingsHandle);
                await browser.closeWindow();
            }
        } finally {
            await switchToWindowWithE2eBridge(mainHandle);
        }
    }
    await callE2eBridge('refreshE2eModel');
}
