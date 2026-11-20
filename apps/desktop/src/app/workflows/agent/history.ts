import type { AgentQueries } from '@/app/api/agent/contracts';
import { AiError } from '@/app/api/agent/errors';
import { createSessionHistory, readSessionHistoryData } from '@/modules/agent';
import type { AgentPresentationTools } from '@/modules/agent/contracts';
import { hydratePersistedAttachments } from '@/modules/attachments';
import { readSessionModelSummary } from '@/modules/models';

export function createAgentHistoryQueries(input: {
    tools: AgentPresentationTools;
    readServerNames(): Promise<readonly { id: number; name: string }[]>;
    tt(text: string, values?: Record<string, string | number>): string;
    error(message: string, error: unknown): void;
}): AgentQueries {
    const history = createSessionHistory({
        hydrateAttachments: hydratePersistedAttachments,
        tools: input.tools,
        messages: {
            tt: input.tt,
            displayError: AiError.getKnownDefaultDisplayMessage,
            retryText: (attempt, maxRetries) =>
                input.tt('重试中...({attempt}/{maxRetries})', { attempt, maxRetries }),
        },
        diagnostics: { error: input.error },
    });
    const read = async (sessionId: number) => {
        const [data, model] = await Promise.all([
            readSessionHistoryData(sessionId),
            readSessionModelSummary(sessionId),
        ]);
        return {
            data,
            information: {
                sessionId: data.session.id,
                title: data.session.title,
                modelId: model?.modelId ?? data.session.model,
                providerId: model?.providerId ?? data.session.provider_id,
            },
        };
    };
    return Object.freeze<AgentQueries>({
        async getSession(sessionId) {
            return (await read(sessionId)).information;
        },
        async loadSession(sessionId) {
            const [{ data, information }, servers] = await Promise.all([
                read(sessionId),
                input.readServerNames(),
            ]);
            const names = new Map(servers.map(({ id, name }) => [id, name]));
            return {
                ...information,
                history: await history.build({
                    messages: data.messages,
                    turns: data.turns,
                    attempts: data.attempts,
                    resolveServerName: (serverId) =>
                        serverId === null ? '' : (names.get(serverId) ?? `MCP 服务器 ${serverId}`),
                }),
            };
        },
    });
}
