import type {
    AiProvider,
    AiProviderConfig,
    AiRequestOptions,
    ModelDiagnostic,
    ModelsHost,
    ProviderDriver,
} from '@touchai/models/contracts';

export interface ConnectionProfile {
    providerId?: number;
    driver: ProviderDriver;
    apiEndpoint: string;
    apiKey?: string;
    config: AiProviderConfig['config'];
    updatedAt?: string | null;
}

export interface ProviderConnectionState extends ConnectionProfile {
    enabled: boolean;
}

export interface ModelSummary {
    modelDbId: number;
    providerId: number;
    providerName: string;
    modelId: string;
    modelName: string;
}

/** Host-only user configuration snapshot, distinct from a row and a provider request. */
export interface ConfiguredModel {
    summary: ModelSummary;
    connection: ConnectionProfile;
    capabilities: {
        contextLimit: number | null;
        outputLimit: number | null;
        supportsImages: boolean;
        supportsFiles: boolean;
        supportsTools: boolean;
        supportsReasoning: boolean;
        reasoningOptions: AiRequestOptions['reasoningOptions'];
        preserveReasoningCache: boolean;
    };
}

export interface ConnectionResources {
    remoteRefs: ModelsHost['remoteRefs'];
    resourceKey(attachmentId: number): string | undefined;
    dispose(): void;
}

export interface ConfiguredModelConnection {
    readonly connectionKey: string;
    readonly providerId?: number;
    provider: AiProvider;
    resourceKey(attachmentId: number): string | undefined;
    dispose(): void;
}

export interface ModelsModuleHost {
    createProvider(options: {
        driver: ProviderDriver;
        config: AiProviderConfig;
        host: ModelsHost;
    }): AiProvider;
    fetch: ModelsHost['fetch'];
    readConnectionState(providerId: number): Promise<ProviderConnectionState | null>;
    createResources(options: {
        providerId?: number;
        bindingUpdatedAt: string | null;
        isCurrentBinding(): Promise<boolean>;
    }): ConnectionResources;
    diagnostics?(event: ModelDiagnostic): void;
}

export interface ModelMetadataRefreshResult {
    status: 'updated' | 'unchanged' | 'skipped' | 'failed';
    reason?: string;
}
