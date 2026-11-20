import type { PersistenceProjectorOptions, PromptSnapshot } from '@/modules/agent';
import { PersistenceProjector, serializePromptSnapshot } from '@/modules/agent';
import type {
    AttachmentDeliveryManifest,
    AttachmentDeliveryManifestRequest,
} from '@/modules/attachments';
import {
    createEmptyAttachmentDeliveryManifest,
    persistPreparedAttachmentWithWriter,
    prepareAttachmentForPersistence,
    serializeAttachmentDeliveryManifest,
    upsertAttachmentDeliveryManifestRequest,
} from '@/modules/attachments';
import { getToolDefinitionMetrics } from '@/modules/tools';
import { buildPromptBreakdown, prepareConsumption } from '@/modules/usage';
import { log } from '@/platform/diagnostics';

export interface TaskPersistenceOptions extends Omit<
    PersistenceProjectorOptions,
    'promptSnapshotJson' | 'deliveryManifestJson' | 'host'
> {
    promptSnapshot: PromptSnapshot;
    deliveryManifest?: AttachmentDeliveryManifest;
}

/** Cross-module projections are prepared here; the history owner keeps the atomic write. */
export function createTaskPersistence(options: TaskPersistenceOptions) {
    const snapshot = structuredClone(options.promptSnapshot);
    return new PersistenceProjector({
        ...options,
        promptSnapshotJson: serializePromptSnapshot(snapshot),
        deliveryManifestJson: options.deliveryManifest
            ? serializeAttachmentDeliveryManifest(options.deliveryManifest)
            : undefined,
        host: {
            prepareAttachments: async (attachments) => {
                await Promise.all(attachments.map(prepareAttachmentForPersistence));
            },
            persistAttachment: persistPreparedAttachmentWithWriter,
            emptyManifest: () =>
                serializeAttachmentDeliveryManifest(createEmptyAttachmentDeliveryManifest()),
            appendManifest: (current, request) =>
                serializeAttachmentDeliveryManifest(
                    upsertAttachmentDeliveryManifestRequest(
                        JSON.parse(current) as AttachmentDeliveryManifest,
                        JSON.parse(request) as AttachmentDeliveryManifestRequest
                    )
                ),
            promptBreakdown: async () => {
                const definitions = await getToolDefinitionMetrics();
                return buildPromptBreakdown(snapshot, definitions.mcp, definitions.builtin);
            },
            resolveUsage: prepareConsumption,
            diagnostics: log,
        },
    });
}
