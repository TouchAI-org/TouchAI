import { createTauriFetch } from '@/platform/http';

import type { ToolRegistration, ToolResult } from '../contracts';
import type { ToolMessages } from '../contracts/host';
import { createExternalAgentAdministration } from './administration.io';
import { EXTERNAL_AGENT_CARD_CACHE_TTL_MS, ExternalAgentCardCache } from './cardCache';
import { EXTERNAL_AGENT_DISCOVERY_TIMEOUT_MS, EXTERNAL_AGENT_POLLING_DEFAULTS } from './constants';
import type {
    ExternalAgentInvocationResult,
    ExternalAgentPollingOptions,
    ExternalAgentRecord,
} from './contracts';
import { isLoopbackExternalAgentUrl, parseExternalAgentUrl } from './urlPolicy';

const LIST_TOOL_NAME = 'builtin__list_external_agents';
const DELEGATE_TOOL_NAME = 'builtin__delegate_to_agent';

const MODEL_DESCRIPTIONS = Object.freeze({
    list: 'List registered external A2A agents.',
    delegate:
        'Delegate one text message to a registered external A2A agent. The user must approve every call.',
    agentId: 'Local ID of the external agent.',
    message: 'Visible text to send to the external agent.',
    mode: 'Synchronous, streaming, asynchronous, or automatic invocation.',
});

const ERROR_MESSAGE_KEYS = {
    agent_unavailable: 'externalAgents.error.agentUnavailable',
    auth_required: 'externalAgents.error.authRequired',
    card_malformed: 'externalAgents.error.cardMalformed',
    cancelled: 'externalAgents.error.cancelled',
    discovery_unavailable: 'externalAgents.error.discoveryUnavailable',
    interface_unavailable: 'externalAgents.error.interfaceUnavailable',
    invalid_response: 'externalAgents.error.invalidResponse',
    payload_too_large: 'externalAgents.error.payloadTooLarge',
    polling_timeout: 'externalAgents.error.pollingTimeout',
    request_failed: 'externalAgents.error.requestFailed',
    stream_disconnected: 'externalAgents.error.streamDisconnected',
    timeout: 'externalAgents.error.timeout',
    unsafe_url: 'externalAgents.error.unsafeUrl',
} as const;

function describeFailure(result: ExternalAgentInvocationResult, t: ToolMessages['t']): string {
    if (!result.code) return result.text;
    const message = t(ERROR_MESSAGE_KEYS[result.code]);
    return [result.text, `${message} [external_agent:${result.code}]`].filter(Boolean).join('\n\n');
}

function failureResult(result: ExternalAgentInvocationResult, t: ToolMessages['t']): ToolResult {
    return {
        result: describeFailure(result, t),
        isError: true,
        status: result.status,
        errorMessage: result.code ?? 'request_failed',
        sideEffect: result.sideEffect,
    };
}

function listResult(rows: readonly ExternalAgentRecord[], t: ToolMessages['t']): ToolResult {
    if (rows.length === 0)
        return {
            result: t('externalAgents.list.empty'),
            isError: false,
            status: 'success',
            sideEffect: 'none',
        };
    const lines = rows.map((row) =>
        [
            `#${row.id} ${row.name}`,
            row.url,
            row.enabled === 1 ? t('common.enabled') : t('common.disabled'),
            row.last_discovered_at ?? t('externalAgents.list.never'),
            row.last_error ?? '',
        ]
            .filter(Boolean)
            .join('\n')
    );
    return {
        result: `${t('externalAgents.list.heading')}\n\n${lines.join('\n\n')}`,
        isError: false,
        status: 'success',
        sideEffect: 'none',
    };
}

export interface CreateExternalAgentsOptions {
    discoveryTimeoutMs?: number;
    fetchImpl?: typeof fetch;
    invocationTimeoutMs?: number;
    messages: ToolMessages;
    now?: () => number;
    polling?: Partial<ExternalAgentPollingOptions>;
    streamSnapshotIntervalMs?: number;
}

export function createExternalAgents(options: CreateExternalAgentsOptions) {
    const t = options.messages.t;
    const fetchImpl = options.fetchImpl ?? createTauriFetch();
    const now = options.now ?? Date.now;
    const cache = new ExternalAgentCardCache(now, EXTERNAL_AGENT_CARD_CACHE_TTL_MS);
    const { administration, registry } = createExternalAgentAdministration({
        cache,
        fetchImpl,
        discoveryTimeoutMs: options.discoveryTimeoutMs ?? EXTERNAL_AGENT_DISCOVERY_TIMEOUT_MS,
        now,
    });
    const polling = { ...EXTERNAL_AGENT_POLLING_DEFAULTS, ...options.polling };

    const listRegistration: ToolRegistration = {
        name: LIST_TOOL_NAME,
        source: 'builtin',
        async prepare() {
            return {
                declaration: {
                    name: LIST_TOOL_NAME,
                    description: MODEL_DESCRIPTIONS.list,
                    input_schema: {
                        type: 'object',
                        properties: {},
                        additionalProperties: false,
                    },
                },
                authorize: async () => true,
                describe: async () => ({
                    action: 'read',
                    target: t('externalAgents.tool.listTarget'),
                }),
                execute: async () => listResult(await administration.findAll(), t),
            };
        },
    };

    const delegateRegistration: ToolRegistration = {
        name: DELEGATE_TOOL_NAME,
        source: 'builtin',
        async prepare() {
            return {
                declaration: {
                    name: DELEGATE_TOOL_NAME,
                    description: MODEL_DESCRIPTIONS.delegate,
                    input_schema: {
                        type: 'object',
                        properties: {
                            agent_id: {
                                type: 'integer',
                                minimum: 1,
                                description: MODEL_DESCRIPTIONS.agentId,
                            },
                            message: {
                                type: 'string',
                                minLength: 1,
                                maxLength: 262_144,
                                description: MODEL_DESCRIPTIONS.message,
                            },
                            mode: {
                                type: 'string',
                                enum: ['auto', 'sync', 'stream', 'async'],
                                default: 'auto',
                                description: MODEL_DESCRIPTIONS.mode,
                            },
                        },
                        required: ['agent_id', 'message'],
                        additionalProperties: false,
                    },
                    adaptiveTimeoutCeilingMs: 600_000,
                },
                authorize: async (_scope, args) => {
                    const agentId = Number(args.agent_id);
                    return (
                        Number.isSafeInteger(agentId) &&
                        (await registry.findEnabled(agentId)) !== null
                    );
                },
                approval: async (args) => {
                    const resolved = await registry.findEnabled(Number(args.agent_id));
                    if (!resolved) return null;
                    const origin = parseExternalAgentUrl(
                        resolved.row.url,
                        isLoopbackExternalAgentUrl(new URL(resolved.row.url))
                    ).origin;
                    const message = String(args.message ?? '');
                    return {
                        title: t('externalAgents.approval.title', { name: resolved.row.name }),
                        description: t('externalAgents.approval.description', {
                            origin,
                            count: message.length,
                        }),
                        command: message,
                        riskLabel: t('externalAgents.approval.risk'),
                        reason: t('externalAgents.approval.reason'),
                        commandLabel: t('externalAgents.approval.commandLabel'),
                        approveLabel: t('common.confirm'),
                        rejectLabel: t('common.cancel'),
                        enterHint: 'Enter',
                        escHint: 'Esc',
                        keyboardApproveDelayMs: 450,
                    };
                },
                execute: async (args, scope) => {
                    const resolved = await registry.findEnabled(Number(args.agent_id));
                    if (!resolved)
                        return failureResult(
                            {
                                code: 'agent_unavailable',
                                sideEffect: 'none',
                                status: 'error',
                                text: '',
                            },
                            t
                        );
                    const loopback = isLoopbackExternalAgentUrl(new URL(resolved.row.url));
                    parseExternalAgentUrl(resolved.row.url, loopback);
                    const { invokeRegisteredExternalAgent } = await import('./invocation');
                    const result = await invokeRegisteredExternalAgent({
                        allowLoopback: loopback,
                        card: resolved.card,
                        fetchImpl,
                        message: String(args.message),
                        mode:
                            (args.mode as 'auto' | 'sync' | 'stream' | 'async' | undefined) ??
                            'auto',
                        onSnapshot: (text) => {
                            if (!scope.signal?.aborted && scope.task && scope.callId) {
                                scope.task.present({
                                    type: 'result_delta',
                                    callId: scope.callId,
                                    result: text,
                                });
                            }
                        },
                        polling,
                        signal: scope.signal,
                        streamSnapshotIntervalMs: options.streamSnapshotIntervalMs,
                        timeoutMs: scope.requestedTimeoutMs ?? options.invocationTimeoutMs,
                        url: resolved.row.url,
                    });
                    return result.status === 'success'
                        ? {
                              result: result.text || t('externalAgents.result.empty'),
                              isError: false,
                              status: 'success',
                              sideEffect: result.sideEffect,
                          }
                        : failureResult(result, t);
                },
            };
        },
    };

    return Object.freeze({
        administration,
        builtinRegistrations: Object.freeze([
            {
                id: 'list_external_agents',
                displayName: 'External agents',
                description: MODEL_DESCRIPTIONS.list,
                riskLevel: 'low',
                defaultConfig: null,
                registration: listRegistration,
            },
            {
                id: 'delegate_to_agent',
                displayName: 'Delegate to external agent',
                description: MODEL_DESCRIPTIONS.delegate,
                riskLevel: 'high',
                defaultConfig: null,
                registration: delegateRegistration,
            },
        ] as const),
        cache,
        registrations: Object.freeze([listRegistration, delegateRegistration] as const),
        dispose() {
            cache.clear();
        },
    });
}
