import { buildModelMessages, buildToolSet } from '@touchai/models';
import type { ProviderDriver } from '@touchai/models/contracts';

import type { DesktopModelRequest } from '@/adapters/models/input';
import { prepareModelRequest } from '@/adapters/models/transport';
import { getCurrentModelLanguageContext } from '@/app/workflows/agent/language';
import type { AttachmentDeliveryManifestRequest } from '@/modules/attachments';

export type AttachmentEncodingContext = NonNullable<
    Parameters<typeof buildModelMessages>[0]['attachmentContext']
>;

/** Exercise the production Desktop translation and neutral encoder together. */
export async function encodeDesktopMessages(input: {
    providerDriver: ProviderDriver;
    modelId: string;
    providerId?: number;
    attachmentRequestIndex?: number;
    messages: DesktopModelRequest['messages'];
    supportsReasoning?: boolean;
    attachmentContext?: AttachmentEncodingContext;
}) {
    let manifestRequest!: AttachmentDeliveryManifestRequest;
    const prepared = prepareModelRequest(
        {
            ...input,
            model: input.modelId,
            onAttachmentManifestResolved: (manifest) => {
                manifestRequest = manifest;
            },
        },
        {
            driver: input.providerDriver,
            providerId: input.providerId,
            resourceKey: (id) => `fixture-resource-${id}`,
        }
    );
    const encoded = await buildModelMessages({ ...input, messages: prepared.messages });
    await prepared.onTransportResolved?.(encoded.transport);
    return { ...encoded, manifestRequest };
}

export function encodeDesktopTools(
    tools: Parameters<typeof buildToolSet>[0],
    modelLanguageContext = getCurrentModelLanguageContext()
) {
    return buildToolSet(
        prepareModelRequest(
            { model: 'fixture', messages: [], tools, modelLanguageContext },
            {
                driver: 'openai',
                resourceKey: () => undefined,
            }
        ).tools
    );
}
