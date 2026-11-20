import { listen } from '@tauri-apps/api/event';
import { afterEach, beforeEach, expect, vi } from 'vitest';

import { EventTriggerRegistry, TaskScheduler } from '@/modules/scheduler';

import { createAgentWindowFixture, network, streamingResponse } from './agentWindow';

let fixture: ReturnType<typeof createAgentWindowFixture>;
let subscriptions: EventTriggerRegistry;
const schedulers: TaskScheduler[] = [];
const active: ReturnType<typeof streamingResponse>[] = [];
const completions = new Set<Promise<unknown>>();
export const schedulerNetwork = network;

beforeEach(async () => {
    fixture = createAgentWindowFixture();
    await fixture.window.ready;
    subscriptions = new EventTriggerRegistry(() => {});
    subscriptions.register({
        eventType: 'app-start',
        displayName: 'App start',
        description: '',
        setup: async (_config, callback) => listen('fixture:app-start', callback),
    });
    vi.useFakeTimers();
    network.respondToGeneration = async () => {
        const channel = streamingResponse();
        active.push(channel);
        return channel.response;
    };
});
afterEach(async () => {
    for (const scheduler of schedulers.splice(0)) scheduler.dispose();
    await fixture.window.dispose();
    active.length = 0;
});

export function eventRegistry() {
    return subscriptions;
}
export async function waitForScheduledIdle() {
    await vi.waitFor(() => expect(fixture.window.api.listActiveTasks()).toHaveLength(0));
    await Promise.all([...completions]);
}
export function createScheduler() {
    const scheduler = new TaskScheduler({
        run: async (input) => {
            const task = await fixture.window.api.startBackgroundTask(input);
            const result = task.completion;
            const completion = result.then(
                () => undefined,
                () => undefined
            );
            completions.add(completion);
            await completion.finally(() => completions.delete(completion));
            await result;
        },
        listen: (trigger, callback) => subscriptions.setupEventTrigger(trigger, callback),
        diagnostics: { warn() {}, error() {} },
    });
    schedulers.push(scheduler);
    return scheduler;
}
export async function releaseBackgroundTasks() {
    for (const channel of active.splice(0)) {
        channel.delta({ role: 'assistant', content: 'Scheduled answer' });
        channel.finish();
    }
    await Promise.all([...completions]);
}
