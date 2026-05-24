import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import {
    formatMcpToolResponse,
    raceWithTimeoutAndSignal,
} from '@/services/AgentService/infrastructure/mcp/utils';

vi.mock('@/services/AgentService/infrastructure/attachments', () => ({
    base64ToUint8Array: vi.fn(),
    createPersistedAttachmentFromData: vi.fn(),
}));

describe('MCP infrastructure i18n', () => {
    beforeEach(() => {
        vi.useRealTimers();
        setLocale('zh-CN');
    });

    it('localizes image and resource fallback tool response text in English', () => {
        setLocale('en-US');

        const result = formatMcpToolResponse({
            success: true,
            content: [
                { type: 'image', mime_type: 'image/png' },
                { type: 'resource', uri: 'file:///tmp/report.pdf' },
            ],
            is_error: false,
        });

        expect(result).toBe('[Image: image/png]\n[Resource: file:///tmp/report.pdf]');
    });

    it('localizes timeout and cancellation errors in English', async () => {
        setLocale('en-US');
        vi.useFakeTimers();

        const timeoutPromise = raceWithTimeoutAndSignal(new Promise(() => undefined), 1000);
        vi.advanceTimersByTime(1000);
        await expect(timeoutPromise).rejects.toThrow('Tool execution timed out (1000ms)');

        const controller = new AbortController();
        controller.abort();
        await expect(
            raceWithTimeoutAndSignal(Promise.resolve('ok'), 1000, controller.signal)
        ).rejects.toThrow('Request cancelled');
    });
});
