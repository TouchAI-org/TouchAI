import type { AgentPreparedTurn } from '@touchai/agent-core/contracts';
import { AgentError } from '@touchai/agent-core/contracts';

import type { AgentMessageAdapter } from '@/adapters/agent/messages';
import { t } from '@/i18n';
import { PendingMessagePersistence, type PersistenceProjector } from '@/modules/agent';
import type { AgentPendingDelivery, DeliveredPendingUserMessage } from '@/modules/agent/contracts';
import {
    type AttachmentCapabilities,
    ensurePersistedAttachmentIndex,
    getUnsupportedAttachmentTypes,
    hydratePersistedAttachmentByHash,
} from '@/modules/attachments';
import { loadSelectedSkills } from '@/modules/skills';
import { log } from '@/platform/diagnostics';
import { sendWindowNotification } from '@/platform/windows/notifications';

import { buildUserPromptMessage } from './transport';

export function createPendingMessagePersistence() {
    return new PendingMessagePersistence({
        prepare: ensurePersistedAttachmentIndex,
        hydrate: hydratePersistedAttachmentByHash,
        diagnostics: log,
    });
}

export function reportQueuedMessageStartFailure() {
    sendWindowNotification({
        title: t('agent.persistenceIssue.title'),
        body: t('agent.persistenceIssue.queuedTurnStart'),
    });
}

/** Materialize first, then atomically commit history and remove the durable queue row. */
export function createPendingMessageDelivery(input: {
    queue: AgentPendingDelivery;
    projector: PersistenceProjector;
    adapter: AgentMessageAdapter;
    capabilities: AttachmentCapabilities;
    diagnostics: { error(message: string, error: unknown): void };
}): NonNullable<AgentPreparedTurn['pendingMessages']> {
    const { queue, projector, adapter } = input;
    return {
        hasImmediate: () => queue.hasImmediate(),
        async deliver(scope) {
            const pending = queue.claimPriority();
            if (!pending.length) return { messages: [] };
            const prepared: DeliveredPendingUserMessage[] = [];
            const messages: Awaited<
                ReturnType<NonNullable<AgentPreparedTurn['pendingMessages']>['deliver']>
            >['messages'] = [];
            const privateContents: NonNullable<
                Awaited<
                    ReturnType<NonNullable<AgentPreparedTurn['pendingMessages']>['deliver']>
                >['privateContents']
            > = [];
            const settled = new Set<string>();
            const rejected: string[] = [];
            const reject = async (id: string, body: string) => {
                await projector.discardPendingUserMessage(id);
                rejected.push(id);
                settled.add(id);
                sendWindowNotification({ title: t('agent.priorityMessage.removedTitle'), body });
            };
            try {
                projector.closeOutputBoundary();
                await queue.flush();
                for (const pendingMessage of pending) {
                    scope.signal.throwIfAborted();
                    if (!queue.isClaimCurrent(pendingMessage.id)) continue;
                    const unsupported = getUnsupportedAttachmentTypes(
                        pendingMessage.attachments,
                        input.capabilities
                    );
                    if (unsupported.length) {
                        await reject(
                            pendingMessage.id,
                            t('agent.priorityMessage.unsupportedAttachmentsBody', {
                                types: unsupported
                                    .map((type) =>
                                        t(
                                            type === 'image'
                                                ? 'agent.priorityMessage.attachmentImage'
                                                : 'agent.priorityMessage.attachmentFile'
                                        )
                                    )
                                    .join(' / '),
                            })
                        );
                        continue;
                    }
                    let message;
                    try {
                        message = await buildUserPromptMessage({
                            prompt: pendingMessage.prompt,
                            attachments: pendingMessage.attachments,
                            attachmentCapabilities: input.capabilities,
                            signal: scope.signal,
                            diagnostics: input.diagnostics,
                        });
                    } catch (error) {
                        scope.signal.throwIfAborted();
                        if (!queue.isClaimCurrent(pendingMessage.id)) continue;
                        input.diagnostics.error(
                            '[Agent] Inserted message preparation failed',
                            error
                        );
                        await reject(
                            pendingMessage.id,
                            t('agent.priorityMessage.prepareFailedBody')
                        );
                        continue;
                    }
                    let skillContext: string;
                    try {
                        const skills = await loadSelectedSkills(
                            pendingMessage.inputSnapshot?.skills ?? [],
                            'user_tag',
                            scope.signal
                        );
                        skillContext = skills
                            .map((skill) => skill.contextText)
                            .join('\n\n')
                            .trim();
                    } catch (error) {
                        scope.signal.throwIfAborted();
                        if (!queue.isClaimCurrent(pendingMessage.id)) continue;
                        input.diagnostics.error(
                            '[Agent] Inserted message skill loading failed',
                            error
                        );
                        await reject(
                            pendingMessage.id,
                            t('agent.priorityMessage.skillLoadFailedBody')
                        );
                        continue;
                    }
                    scope.signal.throwIfAborted();
                    if (!queue.isClaimCurrent(pendingMessage.id)) continue;
                    const coreMessage = adapter.toCore([message])[0]!;
                    messages.push(coreMessage);
                    if (skillContext) {
                        const content = coreMessage.content;
                        privateContents.push({
                            index: messages.length - 1,
                            content:
                                typeof content === 'string'
                                    ? `${skillContext}\n\n${content}`
                                    : [{ type: 'text', text: skillContext }, ...content],
                        });
                    }
                    prepared.push({
                        id: pendingMessage.id,
                        prompt: pendingMessage.prompt,
                        attachments: pendingMessage.attachments,
                        inputSnapshot: pendingMessage.inputSnapshot,
                    });
                }
                scope.signal.throwIfAborted();
                if (!prepared.length) return { messages: [] };
                if (prepared.some((message) => !queue.isClaimCurrent(message.id)))
                    return { messages: [] };
                const sources = await projector.persistInjectedUserMessages(prepared, () => {
                    scope.signal.throwIfAborted();
                    return prepared.every((message) => queue.isClaimCurrent(message.id));
                });
                if (!sources) return { messages: [] };
                for (const [index, message] of prepared.entries()) {
                    const source = sources.get(message.id);
                    if (source) {
                        messages[index]!.origin = adapter.toCoreSource(source);
                        adapter.bindUserMessageSource(
                            adapter.toDesktopContent(messages[index]!.content),
                            source
                        );
                        message.sourceMessageId = source.id;
                    }
                    settled.add(message.id);
                }
                queue.delivered(prepared);
                return { messages, privateContents };
            } catch (cause) {
                scope.signal.throwIfAborted();
                input.diagnostics.error('[Agent] Inserted message persistence failed', cause);
                sendWindowNotification({
                    title: t('agent.persistenceIssue.title'),
                    body: t('agent.persistenceIssue.userMessageDelivery'),
                });
                throw new AgentError('PERSISTENCE_FAILED', false, { cause });
            } finally {
                if (rejected.length) queue.rejected(rejected);
                queue.releasePriority(
                    pending.map((message) => message.id).filter((id) => !settled.has(id))
                );
            }
        },
    };
}
