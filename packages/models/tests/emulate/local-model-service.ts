import { createEmulator } from 'emulate';

/**
 * A real HTTP model service for tests that must not reach a provider.
 *
 * `emulate` serves OpenAI Chat Completions, OpenAI Responses and Anthropic
 * Messages from one process, with scripted rules instead of a model. Tests keep
 * the whole provider stack — SDK, request encoding, streaming, error mapping —
 * and lose only the remote provider: no key, no network, no rate limit, and the
 * same answer on every run.
 *
 * The rule shape mirrors the AI service seed config. Only the matchers and
 * replies the suite uses are declared here; the service validates the rest.
 */

export type AiRuleFormat = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export interface AiRuleMatch {
    format?: AiRuleFormat;
    textContains?: string;
    tool?: string;
    hasToolResult?: boolean;
}

export type AiReplyEvent =
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string }
    | { type: 'tool_call'; name: string; arguments: Record<string, unknown> };

export interface AiRule {
    id: string;
    match?: AiRuleMatch;
    reply?: AiReplyEvent[];
    error?: { status: number; message: string };
    times?: number;
}

export interface LocalModelService {
    /** Root address; adapters append their own `/v1` and generation path. */
    readonly endpoint: string;
    /** Replaces every rule and clears the call record, so each test starts alone. */
    useRules(rules: readonly AiRule[]): Promise<void>;
    close(): Promise<void>;
}

async function control(url: string, method: string, body?: unknown): Promise<void> {
    const response = await fetch(url, {
        method,
        ...(body === undefined
            ? {}
            : {
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(body),
              }),
    });

    if (!response.ok) {
        throw new Error(`${method} ${url} failed: ${response.status} ${await response.text()}`);
    }
}

export async function startLocalModelService(
    options: { models?: readonly string[] } = {}
): Promise<LocalModelService> {
    const emulator = await createEmulator({
        service: 'ai',
        port: 0,
        seed: {
            ai: {
                // A request no rule matches fails loudly instead of echoing, so a
                // matcher that stops matching is a test failure, not a silent pass.
                strict: true,
                ...(options.models ? { models: [...options.models] } : {}),
            },
        },
    });

    const endpoint = `http://127.0.0.1:${new URL(emulator.url).port}`;

    return {
        // The service listens on IPv4 loopback; the literal address keeps a
        // dual-stack resolver from sending a test to ::1 instead.
        endpoint,
        async useRules(rules) {
            await control(`${endpoint}/_ai/rules`, 'PUT', {
                rules,
                strict: true,
                ...(options.models ? { models: [...options.models] } : {}),
            });
            await control(`${endpoint}/_ai/calls`, 'DELETE');
        },
        close: () => emulator.close(),
    };
}
