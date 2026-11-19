import type {
    AgentMessage,
    ContextSummary as CoreSummary,
    ContextSummarySource as CoreSummarySource,
    MessageOrigin,
} from '@touchai/agent-core/contracts';
import { AgentError } from '@touchai/agent-core/contracts';
import type { AiContentPart } from '@touchai/models/contracts';

import type {
    ContextMessageSource,
    ContextSummary,
    ContextSummarySource,
} from '@/modules/agent/contracts';
import type { AttachmentContentPart } from '@/modules/attachments';
import { toProviderMedia } from '@/modules/attachments';

import type { DesktopModelMessage as AiMessage } from '../models/input';

type Media = Extract<AttachmentContentPart, { type: 'image' | 'file' }>;

/** One task owns translation keys; provider connections rebind its media at each transport boundary. */
export function createAgentMessageAdapter() {
    const messageKeys = new Map<number, string>();
    const messageSources = new Map<string, ContextMessageSource>();
    const partKeys = new Map<number, string>();
    const partIds = new Map<string, number>();
    const mediaKeys = new WeakMap<Media, string>();
    const media = new Map<string, Media>();
    let disposed = false;
    const assertActive = () => {
        if (disposed) throw new Error('RESOURCE_BINDING_NOT_FOUND');
    };

    const messageKey = (id: number): string => {
        if (disposed) throw new Error('RESOURCE_BINDING_NOT_FOUND');
        let key = messageKeys.get(id);
        if (!key) {
            key = crypto.randomUUID();
            messageKeys.set(id, key);
            messageSources.set(key, { id, fingerprint: '' });
        }
        return key;
    };
    const sourceId = (key: string): number => {
        const source = messageSources.get(key);
        if (!source || disposed) throw new AgentError('CONTEXT_COMPACTION_FAILED');
        return source.id;
    };
    const toCoreSource = (source: ContextMessageSource): MessageOrigin => {
        const key = messageKey(source.id);
        const previous = messageSources.get(key)!;
        if (previous.fingerprint && previous.fingerprint !== source.fingerprint)
            throw new AgentError('CONTEXT_COMPACTION_FAILED');
        messageSources.set(key, { ...source });
        return { key, order: source.id, fingerprint: source.fingerprint };
    };
    const toDesktopSource = (origin: MessageOrigin): ContextMessageSource => ({
        id: sourceId(origin.key),
        fingerprint: origin.fingerprint,
    });
    const toCoreSummary = (summary: ContextSummary): CoreSummary => {
        if (summary.invalidatedAt !== undefined) throw new AgentError('CONTEXT_COMPACTION_FAILED');
        return {
            id: summary.id,
            text: summary.text,
            firstKeptMessageKey: messageKey(summary.firstKeptMessageId),
            systemMessageKeys: summary.systemMessageIds.map(messageKey),
        };
    };
    const toDesktopSummary = (summary: CoreSummary): ContextSummary => ({
        version: 2,
        id: summary.id,
        text: summary.text,
        firstKeptMessageId: sourceId(summary.firstKeptMessageKey),
        systemMessageIds: summary.systemMessageKeys.map(sourceId),
    });
    const summaryPartKey = (id: number) => {
        assertActive();
        let key = partKeys.get(id);
        if (!key) {
            key = crypto.randomUUID();
            partKeys.set(id, key);
            partIds.set(key, id);
        }
        return key;
    };
    const summaryPartId = (key: string) => {
        const id = partIds.get(key);
        if (id === undefined || disposed) throw new AgentError('CONTEXT_COMPACTION_FAILED');
        return id;
    };
    const toCoreContent = (content: AiMessage['content']): AgentMessage['content'] => {
        assertActive();
        return typeof content === 'string'
            ? content
            : content.map((part) => {
                  if (part.type !== 'image' && part.type !== 'file') return structuredClone(part);
                  let key = mediaKeys.get(part);
                  if (!key || !media.has(key)) {
                      key = crypto.randomUUID();
                      mediaKeys.set(part, key);
                      media.set(key, structuredClone(part));
                  }
                  return toProviderMedia(part, key);
              });
    };
    const toDesktopContent = (content: AgentMessage['content']): AiMessage['content'] => {
        assertActive();
        return typeof content === 'string'
            ? content
            : content.map((part: AiContentPart) => {
                  if (part.type !== 'image' && part.type !== 'file') return structuredClone(part);
                  const stored = part.resourceKey ? media.get(part.resourceKey) : undefined;
                  if (!stored) throw new Error('RESOURCE_BINDING_NOT_FOUND');
                  return structuredClone(stored);
              });
    };
    const toolFields = (message: AiMessage | AgentMessage) => ({
        ...(message.tool_calls ? { tool_calls: structuredClone(message.tool_calls) } : {}),
        ...(message.tool_call_id !== undefined ? { tool_call_id: message.tool_call_id } : {}),
        ...(message.name !== undefined ? { name: message.name } : {}),
        ...(message.isError !== undefined ? { isError: message.isError } : {}),
    });

    return Object.freeze({
        toCore(messages: readonly AiMessage[]): AgentMessage[] {
            if (disposed) throw new Error('RESOURCE_BINDING_NOT_FOUND');
            return messages.map((message) => ({
                role: message.role,
                content: toCoreContent(message.content),
                ...toolFields(message),
                ...(message.contextSource ? { origin: toCoreSource(message.contextSource) } : {}),
                ...(message.contextSummary
                    ? { summary: toCoreSummary(message.contextSummary) }
                    : {}),
                ...(message.contextSummaryPartId !== undefined
                    ? { summaryPartKey: summaryPartKey(message.contextSummaryPartId) }
                    : {}),
            }));
        },
        toDesktop(messages: readonly AgentMessage[]): AiMessage[] {
            assertActive();
            return messages.map((message) => ({
                role: message.role,
                content: toDesktopContent(message.content),
                ...toolFields(message),
                ...(message.origin ? { contextSource: toDesktopSource(message.origin) } : {}),
                ...(message.summary ? { contextSummary: toDesktopSummary(message.summary) } : {}),
                ...(message.summaryPartKey
                    ? { contextSummaryPartId: summaryPartId(message.summaryPartKey) }
                    : {}),
            }));
        },
        toCoreContent,
        toDesktopContent,
        toCoreSource,
        toDesktopSource,
        toCoreSummary,
        toDesktopSummary,
        summaryPartKey,
        messageReference: messageKey,
        messageId: sourceId,
        toDesktopSummarySource(source: CoreSummarySource): ContextSummarySource {
            return {
                messages: source.messages.map(toDesktopSource),
                ...(source.previous ? { previous: toDesktopSummary(source.previous) } : {}),
            };
        },
        retain(messages: readonly AgentMessage[]) {
            assertActive();
            const retained = new Set(
                messages.flatMap((message) =>
                    typeof message.content === 'string'
                        ? []
                        : message.content.flatMap((part) =>
                              (part.type === 'image' || part.type === 'file') && part.resourceKey
                                  ? [part.resourceKey]
                                  : []
                          )
                )
            );
            for (const key of media.keys()) if (!retained.has(key)) media.delete(key);
        },
        dispose() {
            disposed = true;
            media.clear();
            messageKeys.clear();
            messageSources.clear();
            partKeys.clear();
            partIds.clear();
        },
    });
}

export type AgentMessageAdapter = ReturnType<typeof createAgentMessageAdapter>;
