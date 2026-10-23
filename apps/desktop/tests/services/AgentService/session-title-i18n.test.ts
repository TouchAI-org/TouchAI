import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { buildSessionTitle } from '@/services/AgentService/session/title';

describe('user sees a readable session title', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('user sees the app-generated empty title in their own language', () => {
        setLocale('en-US');

        expect(buildSessionTitle('')).toBe('New session');
        expect(buildSessionTitle('   ')).toBe('New session');
    });

    it('user sees their own prompt kept raw instead of translated', () => {
        setLocale('en-US');

        expect(buildSessionTitle('写一份项目计划')).toBe('写一份项目计划');
    });
});
