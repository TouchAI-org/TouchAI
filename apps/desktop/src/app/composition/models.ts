import { createAttachmentRemoteRefs, createAttachmentRemoteRefStore } from '@/modules/attachments';
import {
    createModelAdministration,
    createModelMetadata,
    createModelsModule,
    readConnectionState,
} from '@/modules/models';
import { log } from '@/platform/diagnostics';
import { createTauriFetch } from '@/platform/http';

import { createProviderRegistry } from './providers';

export function assembleModels() {
    const registry = createProviderRegistry();
    const fetch = createTauriFetch();
    const connections = createModelsModule({
        createProvider: registry.createConnection,
        fetch,
        readConnectionState,
        createResources: (options) =>
            createAttachmentRemoteRefs({
                ...options,
                store: createAttachmentRemoteRefStore(options),
            }),
        diagnostics: (event) => log.warn('[Models]', event),
    });
    const metadata = createModelMetadata({
        fetch,
        report: (error) => log.warn('[Models] Metadata refresh failed', error),
    });
    const administration = createModelAdministration();
    return Object.freeze({
        ...connections,
        metadata,
        administration,
        async dispose() {
            await administration.dispose();
            await metadata.dispose();
            connections.dispose();
        },
    });
}
