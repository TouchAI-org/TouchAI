import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { buildSessionTitle } from '@/services/AgentService/session/title';

describe('AgentService session title i18n', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('localizes the app-generated empty session title', () => {
        setLocale('en-US');

        expect(buildSessionTitle('')).toBe('New session');
        expect(buildSessionTitle('   ')).toBe('New session');
    });

    it('keeps user prompt titles raw instead of translating user content', () => {
        setLocale('en-US');

        expect(buildSessionTitle('写一份项目计划')).toBe('写一份项目计划');
    });
});
