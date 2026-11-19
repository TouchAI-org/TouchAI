import { createAgent } from '@touchai/agent-core';
import type { AgentEvent, OutputPart } from '@touchai/agent-core/contracts';
import { describe, expect, it } from 'vitest';

import { deferred, fixtureHost, memoryPersistence } from './fixtures';

const content = (parts: readonly OutputPart[]) => parts.map((part) => part.content).join('');

describe('given streamed output reaches the host persistence boundary', () => {
    it('user keeps one active save and the latest pending output while a slow save applies backpressure', async () => {
        const firstSave = deferred<void>();
        const burst = deferred<void>();
        const latestSaved = deferred<void>();
        const finishStream = deferred<void>();
        const saved: string[] = [];
        const store = memoryPersistence();
        let active = 0;
        let peak = 0;
        const fixture = fixtureHost({
            stream: async function* () {
                for (const value of ['a', 'b', 'c', 'd']) {
                    yield { content: value, textState: 'end', done: false };
                }
                burst.resolve();
                await finishStream.promise;
                yield { content: '', done: true };
            },
            persistence: {
                ...store.persistence,
                async progress(parts) {
                    peak = Math.max(peak, ++active);
                    const snapshot = content(parts);
                    if (snapshot === 'a') await firstSave.promise;
                    saved.push(snapshot);
                    active--;
                    if (snapshot === 'abcd') latestSaved.resolve();
                },
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'keep every completed segment' });
        try {
            await burst.promise;
            expect(saved).toEqual([]);
            expect(peak).toBe(1);
            firstSave.resolve();
            await latestSaved.promise;
            expect(saved).toEqual(['a', 'abcd']);
            finishStream.resolve();
            expect((await task.completion).response).toBe('abcd');
            expect(content(store.terminals[0]!.outputParts)).toBe('abcd');
        } finally {
            firstSave.resolve();
            finishStream.resolve();
            await agent.dispose();
        }
    });

    it('user changes no output between repeated boundaries and does not incur duplicate saves', async () => {
        const saved = deferred<void>();
        const finish = deferred<void>();
        const snapshots: string[] = [];
        const fixture = fixtureHost({
            stream: async function* () {
                yield { content: 'answer', textState: 'end', done: false };
                yield { content: '', textState: 'end', done: false };
                yield { content: '', textState: 'end', done: false };
                await finish.promise;
                yield { content: '', done: true };
            },
            persistence: {
                ...memoryPersistence().persistence,
                async progress(parts) {
                    snapshots.push(content(parts));
                    saved.resolve();
                },
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'unchanged output' });
        try {
            await saved.promise;
            finish.resolve();
            await task.completion;
            expect(snapshots).toEqual(['answer']);
        } finally {
            finish.resolve();
            await agent.dispose();
        }
    });

    it('user keeps streaming after a replaceable save fails and receives the complete terminal answer', async () => {
        const failedSave = deferred<void>();
        const nextSave = deferred<void>();
        const issues: AgentEvent[] = [];
        const saved: string[] = [];
        const store = memoryPersistence();
        const fixture = fixtureHost({
            stream: async function* () {
                yield { content: 'a', textState: 'end', done: false };
                await failedSave.promise;
                yield { content: 'b', textState: 'end', done: false };
                await nextSave.promise;
                yield { content: '', done: true };
            },
            persistence: {
                ...store.persistence,
                async progress(parts) {
                    if (content(parts) === 'a') throw new Error('temporary storage failure');
                    saved.push(content(parts));
                    nextSave.resolve();
                },
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'continue after a progress fault' });
        agent.subscribe(task.taskId, (event) => {
            if (event.type === 'persistence_issue' && event.phase === 'progress') {
                issues.push(event);
                failedSave.resolve();
            }
        });
        try {
            expect((await task.completion).response).toBe('ab');
            expect(saved).toEqual(['ab']);
            expect(issues).toHaveLength(1);
            expect(content(store.terminals[0]!.outputParts)).toBe('ab');
        } finally {
            failedSave.resolve();
            nextSave.resolve();
            await agent.dispose();
        }
    });

    it('user cancels after saved progress and a provider ignoring abort cannot write into the closed task', async () => {
        const saved = deferred<void>();
        const late = deferred<void>();
        const store = memoryPersistence();
        const fixture = fixtureHost({
            stream: async function* () {
                yield { content: 'kept', textState: 'end', done: false };
                await late.promise;
                yield { content: 'late', textState: 'end', done: false };
                yield { content: '', done: true };
            },
            persistence: {
                ...store.persistence,
                async progress(parts, target) {
                    await store.persistence.progress(parts, target);
                    saved.resolve();
                },
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'cancel after progress' });
        try {
            await saved.promise;
            const cancelled = expect(task.completion).rejects.toMatchObject({
                code: 'REQUEST_CANCELLED',
            });
            agent.cancel(task.taskId);
            await cancelled;
            late.resolve();
            await Promise.resolve();
            expect(store.progress.map((write) => write.parts.join(''))).toEqual(['kept']);
            expect(content(store.terminals[0]!.outputParts)).toBe('kept');
            expect(agent.getTask(task.taskId)?.status).toBe('cancelled');
        } finally {
            late.resolve();
            await agent.dispose();
        }
    });

    it('user finishes a step with a slow save and the terminal barrier wins over superseded pending output', async () => {
        const saving = deferred<void>();
        const release = deferred<void>();
        const streamClosed = deferred<void>();
        const records: string[] = [];
        const store = memoryPersistence();
        const fixture = fixtureHost({
            stream: async function* () {
                yield { content: 'a', textState: 'end', done: false };
                await saving.promise;
                yield { content: 'b', textState: 'end', done: false };
                yield { content: '', done: true };
            },
            persistence: {
                ...store.persistence,
                async progress(parts) {
                    saving.resolve();
                    await release.promise;
                    records.push(`progress:${content(parts)}`);
                },
                async finish(terminal, scope) {
                    records.push(`terminal:${content(terminal.outputParts)}`);
                    await store.persistence.finish(terminal, scope);
                },
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'terminal output remains complete' });
        agent.subscribe(task.taskId, (event) => {
            if (event.type === 'stream' && event.chunk.done) streamClosed.resolve();
        });
        try {
            await streamClosed.promise;
            expect(agent.getTask(task.taskId)?.status).toBe('running');
            expect(store.terminals).toEqual([]);
            release.resolve();
            expect((await task.completion).response).toBe('ab');
            expect(records).toEqual(['progress:a', 'terminal:ab']);
        } finally {
            release.resolve();
            await agent.dispose();
        }
    });
});
