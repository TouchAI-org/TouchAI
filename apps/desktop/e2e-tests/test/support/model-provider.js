/**
 * The model service the production agent talks to during E2E.
 *
 * `emulate` serves OpenAI-compatible Chat Completions from a local process, so
 * the desktop app keeps its real HTTP, SSE and tool-call path while the reply is
 * scripted. A rule that stops matching makes the service answer 400 instead of
 * echoing, so a fixture that drifted from the prompts fails the test.
 *
 * Two providers in the seeded database point at the same service under different
 * path prefixes, which keeps connection isolation observable in each call.
 */
import { createEmulator } from 'emulate';

export function messageText(message) {
    return (message?.parts ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
}

/** The latest prompt in a recorded call, independent of earlier history. */
export function latestUserText(call) {
    return messageText(call.messages.findLast((message) => message.role === 'user'));
}

/** Tool results the app sent back after the latest prompt. */
export function toolResultsAfterLatestPrompt(call) {
    const promptIndex = call.messages.findLastIndex((message) => message.role === 'user');
    return call.messages
        .slice(promptIndex + 1)
        .filter((message) => message.role === 'tool')
        .flatMap((message) => message.parts.filter((part) => part.type === 'tool_result'));
}

export async function createModelProvider() {
    const emulator = await createEmulator({
        service: 'ai',
        port: 0,
        seed: { ai: { strict: true } },
    });
    const origin = `http://127.0.0.1:${new URL(emulator.url).port}`;
    const rules = [];
    const errors = [];
    let ruleSequence = 0;

    async function control(path, method, body) {
        const response = await fetch(`${origin}${path}`, {
            method,
            ...(body === undefined
                ? {}
                : {
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify(body),
                  }),
        });

        if (!response.ok) {
            throw new Error(
                `${method} ${path} failed: ${response.status} ${await response.text()}`
            );
        }

        return response;
    }

    async function applyRules() {
        await control('/_ai/rules', 'PUT', { rules, strict: true });
    }

    async function calls() {
        const response = await control('/_ai/calls', 'GET');
        return response.json();
    }

    function nextRuleId(label) {
        ruleSequence += 1;
        return `${label}-${ruleSequence}`;
    }

    const provider = {
        /** Root address; the seeded providers append `/alpha` or `/beta`. */
        baseUrl: `${origin}/v1`,

        /**
         * Script one prompt. A tool request is followed by the same answer once a
         * tool result arrives, which is the shape the agent loop produces. Prompts
         * must be unique and must not be substrings of one another: matching is
         * `textContains` and the first matching rule wins.
         */
        async respond(prompt, { tool, answer, timing } = {}) {
            try {
                if (tool) {
                    rules.push({
                        id: nextRuleId('tool'),
                        match: {
                            textContains: prompt,
                            tool: tool.name,
                        },
                        // A prompt's tool request happens once; the next request for
                        // the same prompt is the continuation that carries its result.
                        // `hasToolResult` cannot separate them: it counts results since
                        // the last assistant message, which includes an earlier turn's
                        // pending result after a failed save.
                        times: 1,
                        reply: [
                            {
                                type: 'tool_call',
                                name: tool.name,
                                arguments: tool.args,
                                ...(tool.id ? { id: tool.id } : {}),
                            },
                        ],
                    });
                }
                rules.push({
                    id: nextRuleId('answer'),
                    match: { textContains: prompt },
                    reply: [{ type: 'text', text: answer }],
                    ...(timing ? { timing } : {}),
                });
                await applyRules();
            } catch (error) {
                errors.push(error);
                throw error;
            }
        },

        /** Append rules the convenience method cannot express, such as a one-time failure. */
        async script(entries) {
            try {
                for (const entry of entries) {
                    rules.push({ ...entry, id: nextRuleId(entry.id ?? 'rule') });
                }
                await applyRules();
            } catch (error) {
                errors.push(error);
                throw error;
            }
        },

        calls,

        async callsFor(prompt) {
            const recorded = await calls();
            return recorded.filter((call) => latestUserText(call) === prompt);
        },

        /** Every scripted request must have matched a rule. */
        async assertHealthy() {
            if (errors.length) {
                throw new AggregateError(errors, 'The model service received an invalid rule set');
            }

            const recorded = await calls();
            const unexpected = recorded.filter(
                (call) => call.matched === null || call.matched === undefined
            );

            if (unexpected.length) {
                throw new AggregateError(
                    unexpected.map(
                        (call) =>
                            new Error(
                                `Model request ${call.seq} on ${call.path} answered ${call.status} for ${JSON.stringify(
                                    latestUserText(call)
                                )}`
                            )
                    ),
                    'The model service answered an unscripted request'
                );
            }
        },

        async close() {
            await emulator.close();
        },
    };

    return provider;
}
