import { clearMocks, mockWindows } from '@tauri-apps/api/mocks';
import type { AgentHost } from '@touchai/agent-core/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { assembleAgentHost, type MainAgentAssembly } from '@/app/composition/main';

afterEach(() => {
    clearMocks();
    window.location.hash = '';
});

function fixture(): MainAgentAssembly {
    const host: AgentHost = {
        prepareTurn: async () => ({
            model: {
                key: 'private-model',
                connectionKey: 'private-connection',
                model: 'fixture',
                contextLimit: 4096,
                outputLimit: 512,
                supportsTools: false,
                supportsReasoning: false,
            },
            messages: [{ role: 'user', content: 'request' }],
            tools: {
                declarations: [],
                execute: async () => {
                    throw new Error('unexpected effect');
                },
            },
            stream: async function* () {
                yield { content: 'answer', done: true, finishReason: 'stop' };
            },
            release: () => {},
        }),
        persistence: () => ({
            start: async () => ({ conversationKey: 'session:1', turnKey: 'turn:1' }),
            progress: async () => {},
            toolCalls: async () => 'message',
            toolResult: async () => {},
            toolRoundSource: async () => undefined,
            checkpoint: async () => {},
            retry: async () => {},
            finish: async () => {},
            validateSummary: async () => {},
            saveSummary: async () => 'part',
        }),
    };
    return {
        host,
        stage: (input) => ({ prompt: input.prompt, signal: input.signal }),
        releaseStaged: () => {},
        observe: () => {},
        releaseTask: async () => {},
        dispose: async () => {},
        sessions: {
            beforeStart: async () => {},
            loadHistory: async () => [],
            modelSummary: () => ({
                modelDbId: 1,
                providerId: 1,
                modelName: 'Fixture',
                modelId: 'fixture',
                providerName: 'Fixture',
            }),
            subscribePresentation: () => () => {},
            messages: {
                tt: (text) => text,
                errorText: (code) => code,
                retryText: (attempt) => `Retry ${attempt}`,
            },
            tools: {
                resolveSemantic: () => null,
                presentation: () => null,
                widgetToolName: 'builtin__show_widget',
            },
        },
    };
}

describe('given execution assembly uses the real native window identity', () => {
    it.each(['settings', 'tray-menu', 'computer-use-glow', 'unknown'])(
        'user cannot create a fallback execution host from the %s window even with a main route',
        (label) => {
            mockWindows(label);
            window.location.hash = '#/main';
            expect(() => assembleAgentHost(fixture())).toThrow('MAIN_EXECUTION_HOST_REQUIRED');
        }
    );

    it('user receives safe session capabilities only from main and disposal makes later starts fail closed', async () => {
        mockWindows('main');
        const assembly = assembleAgentHost(fixture());
        try {
            const started = await assembly.sessions.startTask({ prompt: 'request' });
            expect((await started.completion).response).toBe('answer');
            expect(assembly.sessions.getTaskSnapshot(started.taskId)?.status).toBe('completed');
            expect(Object.keys(assembly)).toEqual(['sessions', 'dispose']);
            expect(JSON.stringify(assembly.sessions.getTaskSnapshot(started.taskId))).not.toContain(
                'private-'
            );
        } finally {
            await assembly.dispose();
        }
        await expect(
            assembly.sessions.startTask({ prompt: 'later request' })
        ).rejects.toMatchObject({ code: 'AGENT_DISPOSED' });
    });

    it('user keeps a committed completion when cleanup and its passive error observer both fail', async () => {
        mockWindows('main');
        const input = fixture();
        input.releaseTask = async () => {
            throw new Error('fixture cleanup failed');
        };
        input.sessions.reportObserverError = () => {
            throw new Error('fixture observer failed');
        };
        const assembly = assembleAgentHost(input);
        try {
            const started = await assembly.sessions.startTask({ prompt: 'request' });
            expect((await started.completion).response).toBe('answer');
            expect(assembly.sessions.getTaskSnapshot(started.taskId)?.status).toBe('completed');
        } finally {
            await assembly.dispose();
        }
    });

    it('user releases a rejected staged request without disturbing the task already using that conversation', async () => {
        mockWindows('main');
        const staged = new Set<string>();
        const input = {
            ...fixture(),
            releaseStaged: (request: { requestKey?: string }) => {
                if (request.requestKey) staged.delete(request.requestKey);
            },
        };
        input.stage = (options) => {
            const requestKey = crypto.randomUUID();
            staged.add(requestKey);
            return {
                prompt: options.prompt,
                conversationKey: `session:${options.sessionId}`,
                requestKey,
            };
        };
        const prepare = input.host.prepareTurn;
        input.host.prepareTurn = async (request, scope) => {
            if (request.requestKey) staged.delete(request.requestKey);
            const prepared = await prepare(request, scope);
            return {
                ...prepared,
                stream: async function* () {
                    yield { content: 'answer in progress', done: false };
                    if (!scope.signal.aborted)
                        await new Promise<void>((resolve) => {
                            scope.signal.addEventListener('abort', () => resolve(), { once: true });
                        });
                    scope.signal.throwIfAborted();
                },
            };
        };
        const assembly = assembleAgentHost(input);
        try {
            const active = await assembly.sessions.startTask({
                prompt: 'first request',
                sessionId: 1,
            });
            await expect
                .poll(() => assembly.sessions.getTaskSnapshot(active.taskId)?.currentModel?.modelId)
                .toBe('fixture');
            await expect(
                assembly.sessions.startTask({ prompt: 'second request', sessionId: 1 })
            ).rejects.toMatchObject({ code: 'SESSION_ACTIVE_TASK_EXISTS' });
            expect([...staged]).toEqual([]);
            expect(assembly.sessions.getSessionStatus(1)?.taskId).toBe(active.taskId);
            assembly.sessions.cancelTask(active.taskId);
            await expect(active.completion).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
            const later = await assembly.sessions.startTask({
                prompt: 'later request',
                sessionId: 1,
            });
            assembly.sessions.cancelTask(later.taskId);
            await expect(later.completion).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
            expect([...staged]).toEqual([]);
        } finally {
            await assembly.dispose();
        }
    });
});
