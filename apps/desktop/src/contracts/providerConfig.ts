// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

export interface ProviderConfigJson {
    headers?: Record<string, string>;
    queryParams?: Record<string, string>;
    managedAuth?: {
        login?: string;
        avatarUrl?: string;
    };
    touchAiMode?: 'managed' | 'custom';
    touchAiCustom?: {
        apiEndpoint?: string;
        apiKey?: string;
    };
}
