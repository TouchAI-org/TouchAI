import type { AiRequestOptions, AiToolDefinition } from '@touchai/models/contracts';

import type { ContextMessageSource, ContextSummary } from '@/modules/agent/contracts';
import type {
    AttachmentContentPart,
    AttachmentDeliveryManifestRequest,
} from '@/modules/attachments';

export interface DesktopModelLanguage {
    locale: 'zh-CN' | 'en-US';
    label: string;
}

/** Host-only transport envelope. None of its provenance enters Models contracts. */
export interface DesktopModelMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string | AttachmentContentPart[];
    tool_calls?: import('@touchai/models/contracts').AiToolCall[];
    tool_call_id?: string;
    name?: string;
    isError?: boolean;
    contextSource?: ContextMessageSource;
    contextSummary?: ContextSummary;
    contextSummaryPartId?: number;
}

export interface DesktopModelRequest extends Omit<
    AiRequestOptions,
    'messages' | 'tools' | 'onTransportResolved'
> {
    messages: DesktopModelMessage[];
    tools?: AiToolDefinition[];
    modelLanguageContext?: DesktopModelLanguage;
    attachmentRequestIndex?: number;
    onAttachmentManifestResolved?(request: AttachmentDeliveryManifestRequest): Promise<void> | void;
}
