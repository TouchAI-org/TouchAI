import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The runtime commits checkpoints that carry the active model, which includes
 * provider credentials. Those checkpoints are internal to the executor: the
 * page observes a task through `TaskViewSnapshot` and the completion result,
 * and neither may expose a checkpoint or a credential. The runtime is the only
 * thing stubbed; the snapshot pipeline (center + projection) runs for real.
 */
const runtimeState = vi.hoisted(() => ({
    run: vi.fn(),
    instances: [] as Array<{ options: Record<string, unknown> }>,
}));

function latestOptions(): Record<string, unknown> & {
    onTurnEvent?: (event: Record<string, unknown>) => void;
} {
    const entries = runtimeState.instances;
    return (entries[entries.length - 1]?.options ?? {}) as never;
}

const historyState = vi.hoisted(() => ({ loadSessionHistory: vi.fn() }));

vi.mock('@/services/AgentService/execution/runtime', async () => {
    const actual = await vi.importActual<
        typeof import('@/services/AgentService/execution/runtime')
    >('@/services/AgentService/execution/runtime');

    class StubConversationRuntime {
        constructor(_executor: unknown, options: never) {
            runtimeState.instances.push({ options });
        }

        run() {
            return runtimeState.run();
        }
    }

    return { ...actual, AiConversationRuntime: StubConversationRuntime };
});

vi.mock('@/services/AgentService/session/history', () => ({
    loadSessionHistory: historyState.loadSessionHistory,
}));

const { SessionTaskCenter } = await import('@/services/AgentService/task/center');
const { summarizeTaskModel } = await import('@/services/AgentService/execution/runtime');

/** The fields a page is allowed to observe on a task snapshot. */
const SNAPSHOT_KEYS = [
    'currentModel',
    'error',
    'executionMode',
    'modelSwitchCount',
    'pendingApprovals',
    'pendingToolApproval',
    'pendingUserMessages',
    'pendingUserQuestion',
    'sessionHistory',
    'sessionId',
    'startedAt',
    'status',
    'taskId',
    'turnId',
    'updatedAt',
];

const MODEL_SUMMARY_KEYS = ['modelDbId', 'modelId', 'modelName', 'providerId', 'providerName'];

/** A model row as it comes back from the database, credentials included. */
const credentialModel = {
    id: 7,
    provider_id: 3,
    model_id: 'mimo-v2.5',
    name: 'MiMo v2.5',
    provider_name: 'Xiaomi MiMo',
    api_key: 'ta_live_secret_key',
    provider_config_json: '{"token":"secret"}',
};

/** An executor checkpoint carrying the credential-bearing active model. */
const credentialCheckpoint = {
    activeModel: credentialModel,
    messages: [{ role: 'user', content: 'hello' }],
    response: '',
    reasoning: '',
    iteration: 0,
    modelSwitchCount: 0,
    modelLanguageContext: { locale: 'zh-CN', label: 'Simplified Chinese' },
    executedBuiltInToolIds: [],
    outputParts: [],
};

/** A runtime that binds to its session, commits a checkpoint, then stays running. */
function staysRunningAfterCheckpoint() {
    return () => {
        const options = latestOptions();
        options.onTurnEvent?.({
            type: 'task_started',
            sessionId: 1,
            turnId: 1,
            executionMode: 'foreground',
            model: summarizeTaskModel(credentialModel as never),
        });
        options.onTurnEvent?.({
            type: 'checkpoint_committed',
            taskId: 'task-1',
            checkpoint: credentialCheckpoint,
        });
        return new Promise(() => {});
    };
}

async function startAndCapture(): Promise<Record<string, unknown>> {
    runtimeState.run.mockImplementation(staysRunningAfterCheckpoint());

    const center = new SessionTaskCenter();
    const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });

    const delivered: Array<Record<string, unknown>> = [];
    center.subscribeTask(started.taskId, (snapshot) =>
        delivered.push(snapshot as unknown as Record<string, unknown>)
    );

    // The runtime never resolves; release the coalescer timer so it cannot fire
    // (and emit) after the test file has torn down.
    center.dispose();

    return delivered[delivered.length - 1]!;
}

describe('user watches a running task that commits checkpoints', () => {
    beforeEach(() => {
        runtimeState.run.mockReset();
        runtimeState.instances.length = 0;
        historyState.loadSessionHistory.mockReset();
        historyState.loadSessionHistory.mockResolvedValue([]);
    });

    it('user never sees internal checkpoint state or provider credentials in the task snapshot', async () => {
        const snapshot = await startAndCapture();

        expect(Object.keys(snapshot).sort()).toEqual([...SNAPSHOT_KEYS].sort());

        const serialized = JSON.stringify(snapshot);
        expect(serialized).not.toContain('api_key');
        expect(serialized).not.toContain('provider_config_json');
        expect(serialized).not.toContain('ta_live_secret_key');
        expect(serialized).not.toContain('checkpoint');
    });

    it('user keeps seeing the running status and prompt message after a checkpoint is committed', async () => {
        const snapshot = await startAndCapture();

        expect(snapshot.status).toBe('running');
        expect(snapshot.sessionHistory).toEqual(
            expect.arrayContaining([expect.objectContaining({ role: 'user', content: 'Hi' })])
        );
    });
});

describe('user reads the model attached to a task', () => {
    it('user never sees provider credentials in the model summary', () => {
        const summary = summarizeTaskModel(credentialModel as never);

        expect(Object.keys(summary).sort()).toEqual([...MODEL_SUMMARY_KEYS].sort());
        expect(JSON.stringify(summary)).not.toContain('ta_live_secret_key');
        expect(JSON.stringify(summary)).not.toContain('api_key');
        expect(JSON.stringify(summary)).not.toContain('provider_config_json');
    });
});
