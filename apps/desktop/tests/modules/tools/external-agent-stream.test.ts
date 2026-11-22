import { describe, expect, it } from 'vitest';

import { ExternalAgentError, externalAgentError } from '@/modules/tools/external-agents/errors';
import {
    ExternalAgentStreamAccumulator,
    isInterruptedTaskState,
    isTerminalTaskState,
    messageText,
    taskArtifacts,
    taskState,
    taskText,
} from '@/modules/tools/external-agents/stream';

function message(text: string, role = 1) {
    return {
        messageId: 'message-1',
        role,
        parts: [{ content: { $case: 'text', value: text } }],
    };
}

function task(
    id: string,
    state: number,
    options: {
        artifacts?: Array<{ artifactId: string; parts: unknown[] }>;
        statusMessage?: unknown;
    } = {}
) {
    return {
        id,
        status: {
            state,
            ...(options.statusMessage === undefined ? {} : { message: options.statusMessage }),
        },
        artifacts: options.artifacts ?? [],
    };
}

function payload(value: unknown) {
    return { payload: value };
}

describe('given a user receives A2A stream updates', () => {
    it('user sees a direct message and a completed terminal state', () => {
        const accumulator = new ExternalAgentStreamAccumulator();

        expect(
            accumulator.apply(payload({ $case: 'message', value: message('Direct answer') }))
        ).toBe('Direct answer');
        expect(accumulator.terminal).toBe(true);
        expect(accumulator.state).toBe(3);
        expect(accumulator.currentTaskId()).toBeUndefined();
    });

    it('user sees task status and artifact updates replace or append text in order', () => {
        const accumulator = new ExternalAgentStreamAccumulator();
        const initial = task('task-1', 2, {
            statusMessage: message('Working'),
            artifacts: [{ artifactId: 'answer', parts: [{ text: 'First' }] }],
        });

        expect(accumulator.apply(payload({ $case: 'task', value: initial }))).toBe(
            'Working\nFirst'
        );
        expect(accumulator.currentTaskId()).toBe('task-1');

        expect(
            accumulator.apply(
                payload({
                    $case: 'statusUpdate',
                    value: {
                        taskId: 'task-1',
                        status: { state: 3, message: message('Complete') },
                    },
                })
            )
        ).toBe('Complete\nFirst');
        expect(accumulator.terminal).toBe(true);

        expect(
            accumulator.apply(
                payload({
                    $case: 'artifactUpdate',
                    value: {
                        taskId: 'task-1',
                        artifact: {
                            artifactId: 'answer',
                            parts: [{ text: ' and second' }],
                        },
                        append: true,
                    },
                })
            )
        ).toBe('Complete\nFirst and second');

        expect(
            accumulator.apply(
                payload({
                    $case: 'artifactUpdate',
                    value: {
                        taskId: 'task-1',
                        artifact: {
                            artifactId: 'answer',
                            parts: [{ text: 'Replacement' }],
                        },
                        append: false,
                    },
                })
            )
        ).toBe('Complete\nReplacement');
    });

    it('user sees task text combined from a status message and artifacts', () => {
        const value = task('task-1', 3, {
            statusMessage: message('Status text'),
            artifacts: [
                { artifactId: 'first', parts: [{ text: 'Artifact one' }] },
                { artifactId: 'second', parts: [{ text: 'Artifact two' }] },
            ],
        });

        expect(taskText(value)).toBe('Status text\nArtifact one\nArtifact two');
        expect(taskState(value)).toBe(3);
        expect(taskArtifacts(value)).toEqual(
            new Map([
                ['first', 'Artifact one'],
                ['second', 'Artifact two'],
            ])
        );
        expect(isTerminalTaskState(3)).toBe(true);
        expect(isTerminalTaskState(4)).toBe(true);
        expect(isInterruptedTaskState(6)).toBe(true);
        expect(isInterruptedTaskState(8)).toBe(true);
        expect(isInterruptedTaskState(2)).toBe(false);
    });
});

describe('given a user receives malformed A2A stream data', () => {
    it.each([
        ['an envelope without a payload', () => new ExternalAgentStreamAccumulator().apply({})],
        [
            'an unsupported payload',
            () =>
                new ExternalAgentStreamAccumulator().apply(
                    payload({ $case: 'unsupported', value: {} })
                ),
        ],
        [
            'a task without an id',
            () =>
                new ExternalAgentStreamAccumulator().apply(
                    payload({ $case: 'task', value: task('', 2) })
                ),
        ],
        ['a message with an invalid role', () => messageText(message('Invalid', 9))],
        [
            'a message with invalid parts',
            () => messageText({ messageId: 'message-1', role: 1, parts: 'invalid' }),
        ],
        ['a task with an unknown state', () => taskState(task('task-1', 99))],
        [
            'an artifact with invalid parts',
            () =>
                taskArtifacts({
                    id: 'task-1',
                    status: { state: 2 },
                    artifacts: [{ artifactId: 'answer', parts: 'invalid' }],
                }),
        ],
        [
            'a status update without a task id',
            () =>
                new ExternalAgentStreamAccumulator().apply(
                    payload({ $case: 'statusUpdate', value: { status: { state: 2 } } })
                ),
        ],
        [
            'a status update with an unknown state',
            () =>
                new ExternalAgentStreamAccumulator().apply(
                    payload({
                        $case: 'statusUpdate',
                        value: { taskId: 'task-1', status: { state: 99 } },
                    })
                ),
        ],
        [
            'an artifact update without an artifact',
            () =>
                new ExternalAgentStreamAccumulator().apply(
                    payload({ $case: 'artifactUpdate', value: { taskId: 'task-1' } })
                ),
        ],
    ])('user sees %s rejected as an invalid response', (_case, action) => {
        expect(action).toThrow('invalid_response');
    });
});

describe('given an external agent failure reaches the user', () => {
    it('user sees the original stable error code', () => {
        const original = new ExternalAgentError('unsafe_url');

        expect(externalAgentError(original, 'request_failed')).toBe(original);
    });

    it('user sees an ordinary failure mapped to the requested stable code', () => {
        const cause = new Error('fixture transport failure');
        const mapped = externalAgentError(cause, 'discovery_unavailable');

        expect(mapped).toMatchObject({
            name: 'ExternalAgentError',
            code: 'discovery_unavailable',
            cause,
        });
    });
});
