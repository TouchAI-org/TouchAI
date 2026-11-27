import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

import {
    type ScheduledTasksApi,
    scheduledTasksApiKey,
    ScheduledTasksError,
    useScheduledTasksApi,
} from '@/app/api/scheduler/administration';

describe('user reaches scheduled tasks from an administration surface', () => {
    it('user receives the scheduler API provided by the current surface', async () => {
        const api: ScheduledTasksApi = {
            list: vi.fn().mockResolvedValue([]),
            create: vi.fn(),
            update: vi.fn(),
            remove: vi.fn(),
            runs: vi.fn().mockResolvedValue([]),
        };
        const Probe = defineComponent({
            setup() {
                return { api: useScheduledTasksApi() };
            },
            template: '<span>{{ api === null }}</span>',
        });

        const wrapper = mount(Probe, {
            global: {
                provide: {
                    [scheduledTasksApiKey]: api,
                },
            },
        });

        expect((wrapper.vm as unknown as { api: ScheduledTasksApi }).api).toBe(api);
        await expect(api.runs('schedule-1')).resolves.toEqual([]);
    });

    it('user gets a recoverable unavailable error when no scheduler API is provided', () => {
        const Probe = defineComponent({
            setup() {
                useScheduledTasksApi();
                return {};
            },
            template: '<span />',
        });

        expect(() => mount(Probe)).toThrowError(ScheduledTasksError);
        expect(() => mount(Probe)).toThrowError('SCHEDULED_TASKS_UNAVAILABLE');
    });
});
