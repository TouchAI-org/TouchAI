import type { AiRequestOptions, AiStreamChunk } from '@touchai/models/contracts';
import { AiError, AiErrorCode } from '@touchai/models/contracts';

import type { AttachmentDeliveryManifestRequest } from '@/modules/attachments';
import type { ConfiguredModelConnection } from '@/modules/models';

import { findModelConfigurationError } from '../models/errors';
import type { DesktopModelLanguage as ModelLanguageContext } from '../models/input';
import type { DesktopModelRequest } from '../models/input';
import { prepareModelRequest } from '../models/transport';
import type { AgentMessageAdapter } from './messages';

export interface CoreModelStreamOptions {
    connection: ConfiguredModelConnection;
    messages: AgentMessageAdapter;
    languageContext: ModelLanguageContext;
    nextRequestIndex(): number;
    saveManifest(manifest: AttachmentDeliveryManifestRequest): Promise<void>;
    protect?(
        request: DesktopModelRequest,
        send: (request: DesktopModelRequest) => AsyncIterable<AiStreamChunk>
    ): AsyncIterable<AiStreamChunk>;
}

/** Model transport sees opaque resources; Desktop retains the unchanged durable provenance. */
export function createCoreModelStream(options: CoreModelStreamOptions) {
    const stream = options.connection.provider.stream.bind(options.connection.provider);
    const driver = options.connection.provider.driver;
    const providerId = options.connection.providerId;
    const resourceKey = options.connection.resourceKey.bind(options.connection);
    const toDesktop = options.messages.toDesktop.bind(options.messages);
    const nextRequestIndex = options.nextRequestIndex.bind(options);
    const saveManifest = options.saveManifest.bind(options);
    const languageContext = structuredClone(options.languageContext);

    return async function* (request: AiRequestOptions): AsyncGenerator<AiStreamChunk> {
        request.signal?.throwIfAborted();
        const desktop: DesktopModelRequest = {
            ...request,
            messages: await Promise.all(
                toDesktop(request.messages).map(async (message) => ({
                    ...message,
                    ...(message.role === 'user' && !message.contextSource
                        ? {
                              contextSource: await options.messages.resolveUserMessageSource(
                                  message.content
                              ),
                          }
                        : {}),
                }))
            ),
            attachmentRequestIndex: nextRequestIndex(),
            onAttachmentManifestResolved: saveManifest,
            modelLanguageContext: languageContext,
        };
        const prepared = prepareModelRequest(desktop, { driver, providerId, resourceKey });
        const send = (input: DesktopModelRequest) => {
            if (input === desktop) return stream(prepared);
            const masked = prepareModelRequest(input, { driver, providerId, resourceKey });
            // Transport names may be masked; the local manifest retains original provenance.
            masked.onTransportResolved = prepared.onTransportResolved;
            return stream(masked);
        };
        try {
            yield* options.protect ? options.protect(desktop, send) : send(desktop);
        } catch (error) {
            const configuration = findModelConfigurationError(error);
            if (configuration) {
                throw new AiError(
                    AiErrorCode.INVALID_CONFIG,
                    { reason: configuration.code, details: configuration.details },
                    undefined,
                    { cause: error }
                );
            }
            throw error;
        }
    };
}
