import { describe, expect, it } from 'vitest';

import {
    isSeededSessionReady,
    seededSessionMessageId,
} from '../../../scripts/perf/710/history-session.mjs';

describe('user opens a virtualized RFC 710 history session', () => {
    it('user sees the session ready when only the final virtualized message is mounted', () => {
        expect(seededSessionMessageId(100)).toBe('assistant-100');
        expect(
            isSeededSessionReady({
                historyLevel: 100,
                mountedMessageIds: ['assistant-100'],
            })
        ).toBe(true);
    });

    it('user does not treat a partially mounted virtualized session as ready', () => {
        expect(
            isSeededSessionReady({
                historyLevel: 100,
                mountedMessageIds: ['user-1', 'assistant-2'],
            })
        ).toBe(false);
    });

    it('user maps an odd message count to its final user message', () => {
        expect(seededSessionMessageId(101)).toBe('user-101');
        expect(
            isSeededSessionReady({
                historyLevel: 101,
                mountedMessageIds: ['user-101'],
            })
        ).toBe(true);
    });

    it('user never treats an empty history level as a mounted seeded session', () => {
        expect(seededSessionMessageId(0)).toBeNull();
        expect(
            isSeededSessionReady({
                historyLevel: 0,
                mountedMessageIds: ['assistant-0'],
            })
        ).toBe(false);
    });
});
