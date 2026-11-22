import type { AgentCard, AgentInterface } from '@a2a-js/sdk';
import { z } from 'zod';

import { EXTERNAL_AGENT_CARD_MAX_BYTES, EXTERNAL_AGENT_DISCOVERY_TIMEOUT_MS } from './constants';
import type { ExternalAgentCard } from './contracts';
import { ExternalAgentError, externalAgentError } from './errors';
import { assertSameOrigin, createGuardedFetch, parseExternalAgentUrl } from './urlPolicy';

const agentInterfaceSchema = z.object({
    url: z.string().min(1),
    protocolBinding: z.string().min(1),
    protocolVersion: z.string().min(1),
    tenant: z.string().optional().default(''),
});

const agentCardSchema = z
    .object({
        name: z.string().trim().min(1).max(256),
        description: z.string().optional().default(''),
        version: z.string().trim().min(1).max(128),
        supportedInterfaces: z.array(agentInterfaceSchema).min(1),
        capabilities: z
            .object({
                streaming: z.boolean().optional().default(false),
                pushNotifications: z.boolean().optional().default(false),
                extendedAgentCard: z.boolean().optional().default(false),
                extensions: z.array(z.unknown()).optional().default([]),
            })
            .passthrough()
            .optional()
            .default({
                extensions: [],
                extendedAgentCard: false,
                pushNotifications: false,
                streaming: false,
            }),
        securitySchemes: z.record(z.string(), z.unknown()).optional().default({}),
        securityRequirements: z.array(z.unknown()).optional().default([]),
        defaultInputModes: z.array(z.string()).optional().default([]),
        defaultOutputModes: z.array(z.string()).optional().default([]),
        skills: z.array(z.unknown()).optional().default([]),
    })
    .passthrough();

export function parseExternalAgentCard(value: unknown): AgentCard {
    const parsed = agentCardSchema.safeParse(value);
    if (!parsed.success) throw new ExternalAgentError('card_malformed');
    return parsed.data as unknown as AgentCard;
}

export function resolveCompatibleInterface(
    card: AgentCard,
    baseUrl: URL,
    allowLoopback: boolean
): AgentInterface {
    const compatible = card.supportedInterfaces.find(
        (candidate) =>
            candidate.protocolBinding.toUpperCase() === 'HTTP+JSON' &&
            candidate.protocolVersion === '1.0'
    );
    if (!compatible) throw new ExternalAgentError('interface_unavailable');
    let interfaceUrl: URL;
    try {
        interfaceUrl = new URL(compatible.url);
    } catch (error) {
        throw new ExternalAgentError('card_malformed', { cause: error });
    }
    assertSameOrigin(baseUrl, interfaceUrl);
    parseExternalAgentUrl(interfaceUrl.toString(), allowLoopback);
    return compatible;
}

async function readLimitedJson(response: Response): Promise<unknown> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > EXTERNAL_AGENT_CARD_MAX_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new ExternalAgentError('payload_too_large');
    }
    if (!response.body) throw new ExternalAgentError('card_malformed');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > EXTERNAL_AGENT_CARD_MAX_BYTES) {
                await reader.cancel();
                throw new ExternalAgentError('payload_too_large');
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
    } finally {
        reader.releaseLock();
    }
    try {
        return JSON.parse(text) as unknown;
    } catch (error) {
        throw new ExternalAgentError('card_malformed', { cause: error });
    }
}

export async function discoverExternalAgent(input: {
    allowLoopback: boolean;
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
    url: string;
}): Promise<ExternalAgentCard> {
    const baseUrl = parseExternalAgentUrl(input.url, input.allowLoopback);
    const cardUrl = new URL('/.well-known/agent-card.json', baseUrl);
    const guardedFetch = createGuardedFetch(input.fetchImpl, {
        allowLoopback: input.allowLoopback,
    });
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(new DOMException('timeout', 'TimeoutError')),
        input.timeoutMs ?? EXTERNAL_AGENT_DISCOVERY_TIMEOUT_MS
    );
    const onAbort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const response = await guardedFetch(cardUrl, {
            headers: { Accept: 'application/json', 'A2A-Version': '1.0' },
            signal: controller.signal,
        });
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new ExternalAgentError('discovery_unavailable');
        }
        const card = parseExternalAgentCard(await readLimitedJson(response));
        const compatibleInterface = resolveCompatibleInterface(card, baseUrl, input.allowLoopback);
        return {
            card,
            compatibleInterface,
            origin: baseUrl.origin,
            url: baseUrl.toString(),
        };
    } catch (error) {
        if (error instanceof ExternalAgentError) throw error;
        if (controller.signal.aborted) throw new ExternalAgentError('discovery_unavailable');
        throw externalAgentError(error, 'discovery_unavailable');
    } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
    }
}
