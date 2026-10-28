import { describe, expect, it } from 'vitest';

import {
    captureScrollSnapshot,
    resolveRestoredScrollTop,
} from '@/views/SettingsView/sectionScrollMemory';

describe('settings section scroll memory', () => {
    it('captures the container position', () => {
        expect(
            captureScrollSnapshot({ scrollTop: 120, scrollHeight: 900, clientHeight: 400 })
        ).toEqual({ scrollTop: 120, scrollHeight: 900, clientHeight: 400 });
        expect(captureScrollSnapshot(null)).toBeNull();
    });

    it('starts a never-visited section at the top', () => {
        expect(resolveRestoredScrollTop(undefined, 900, 400)).toBe(0);
    });

    it('restores the remembered position for a visited section', () => {
        expect(resolveRestoredScrollTop(180, 900, 400)).toBe(180);
    });

    it('clamps to the new content height so short sections do not land in blank space', () => {
        // 上次在长页面滚到 600，切到只有 300 高内容的页面。
        expect(resolveRestoredScrollTop(600, 300, 400)).toBe(0);
        expect(resolveRestoredScrollTop(600, 700, 400)).toBe(300);
    });
});
