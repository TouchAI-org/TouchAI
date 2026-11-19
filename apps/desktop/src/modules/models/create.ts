import type { AiProvider, AiRequestOptions, ModelInfo } from '@touchai/models/contracts';

import { awaitAbortable } from '@/utils/abort';

import type { ConfiguredModelConnection, ConnectionProfile, ModelsModuleHost } from './contracts';
import { ModelConfigurationError } from './errors';

function sameConnection(left: ConnectionProfile, right: ConnectionProfile): boolean {
    return (
        left.driver === right.driver &&
        left.apiEndpoint === right.apiEndpoint &&
        left.apiKey === right.apiKey &&
        JSON.stringify(left.config) === JSON.stringify(right.config)
    );
}

export function createModelsModule(inputHost: ModelsModuleHost) {
    const host: ModelsModuleHost = Object.freeze({
        createProvider: inputHost.createProvider.bind(inputHost),
        fetch: inputHost.fetch.bind(inputHost),
        readConnectionState: inputHost.readConnectionState.bind(inputHost),
        createResources: inputHost.createResources.bind(inputHost),
        diagnostics: inputHost.diagnostics?.bind(inputHost),
    });
    const connections = new Set<ConfiguredModelConnection>();
    const active = new Set<{
        profile: ConnectionProfile;
        connection: ConfiguredModelConnection;
        leases: number;
    }>();
    let disposed = false;
    function openConnection(
        input: ConnectionProfile,
        purpose: 'execution' | 'discovery'
    ): ConfiguredModelConnection {
        if (disposed) throw new Error('Models module disposed');
        const profile = structuredClone(input);
        let released = false;
        const isCurrentBinding = async () => {
            if (profile.providerId === undefined || released || disposed) return false;
            const state = await host.readConnectionState(profile.providerId);
            return (
                state !== null &&
                state.enabled &&
                sameConnection(profile, state) &&
                !released &&
                !disposed
            );
        };
        const resources = host.createResources({
            providerId: profile.providerId,
            bindingUpdatedAt: profile.updatedAt ?? null,
            isCurrentBinding,
        });
        let provider: AiProvider;
        try {
            provider = host.createProvider({
                driver: profile.driver,
                config: {
                    apiEndpoint: profile.apiEndpoint,
                    apiKey: profile.apiKey,
                    config: profile.config,
                },
                host: {
                    fetch: async (request, init) => {
                        if (profile.providerId !== undefined) {
                            const state = await host.readConnectionState(profile.providerId);
                            if (!state || (purpose === 'execution' && !state.enabled))
                                throw new ModelConfigurationError('PROVIDER_DISABLED');
                            if (!sameConnection(profile, state))
                                throw new ModelConfigurationError('PROVIDER_BINDING_REVOKED');
                        }
                        if (released || disposed) throw new Error('MODEL_CONNECTION_DISPOSED');
                        if (init?.signal?.aborted)
                            throw new DOMException('The request was aborted', 'AbortError');
                        return host.fetch(request, init);
                    },
                    remoteRefs: resources.remoteRefs,
                    diagnostics: host.diagnostics,
                },
            });
        } catch (error) {
            resources.dispose();
            throw error;
        }
        const connection: ConfiguredModelConnection = Object.freeze({
            connectionKey: crypto.randomUUID(),
            providerId: profile.providerId,
            provider,
            resourceKey: (id: number) =>
                released || disposed ? undefined : resources.resourceKey(id),
            dispose() {
                if (released) return;
                released = true;
                try {
                    provider.dispose();
                } finally {
                    resources.dispose();
                    connections.delete(connection);
                }
            },
        });
        connections.add(connection);
        return connection;
    }
    function createConnection(input: ConnectionProfile): ConfiguredModelConnection {
        return openConnection(input, 'execution');
    }
    return Object.freeze({
        createConnection,
        async discoverModels(providerId: number, signal?: AbortSignal): Promise<ModelInfo[]> {
            if (disposed) throw new Error('Models module disposed');
            const profile = await awaitAbortable(
                () => host.readConnectionState(providerId),
                signal
            );
            signal?.throwIfAborted();
            if (!profile) throw new ModelConfigurationError('MODEL_NOT_FOUND');
            // Administrative discovery never exposes an executable disabled-profile connection.
            const connection = openConnection(profile, 'discovery');
            const cancel = () => connection.dispose();
            signal?.addEventListener('abort', cancel, { once: true });
            try {
                return await awaitAbortable(() => connection.provider.listModels(), signal);
            } finally {
                signal?.removeEventListener('abort', cancel);
                connection.dispose();
            }
        },
        acquireConnection(input: ConnectionProfile): ConfiguredModelConnection {
            if (disposed) throw new Error('Models module disposed');
            let entry = [...active].find(
                (entry) =>
                    entry.profile.providerId === input.providerId &&
                    sameConnection(entry.profile, input)
            );
            if (!entry) {
                entry = {
                    profile: structuredClone(input),
                    connection: createConnection(input),
                    leases: 0,
                };
                active.add(entry);
            }
            const owned = entry;
            owned.leases++;
            let released = false;
            const requireLive = () => {
                if (released || disposed) throw new Error('MODEL_CONNECTION_DISPOSED');
            };
            const provider = owned.connection.provider;
            const leaseProvider: AiProvider = Object.freeze({
                name: provider.name,
                driver: provider.driver,
                async request(options: AiRequestOptions) {
                    requireLive();
                    const response = await provider.request(options);
                    requireLive();
                    return response;
                },
                async *stream(options: AiRequestOptions) {
                    requireLive();
                    for await (const chunk of provider.stream(options)) {
                        requireLive();
                        yield chunk;
                    }
                },
                async testConnection() {
                    requireLive();
                    const result = await provider.testConnection();
                    requireLive();
                    return result;
                },
                async listModels() {
                    requireLive();
                    const result = await provider.listModels();
                    requireLive();
                    return result;
                },
                getApiTargets() {
                    requireLive();
                    return provider.getApiTargets();
                },
                classifyError: provider.classifyError?.bind(provider),
                dispose: release,
            });
            function release(): void {
                if (released) return;
                released = true;
                if (--owned.leases === 0) {
                    active.delete(owned);
                    owned.connection.dispose();
                }
            }
            return Object.freeze({
                connectionKey: owned.connection.connectionKey,
                providerId: owned.connection.providerId,
                provider: leaseProvider,
                resourceKey: (id: number) =>
                    released || disposed ? undefined : owned.connection.resourceKey(id),
                dispose: release,
            });
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const connection of [...connections]) connection.dispose();
            active.clear();
        },
    });
}

export type ModelsModule = ReturnType<typeof createModelsModule>;
