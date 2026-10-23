import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { getRetryStatusMessage } from '@/services/AgentService/execution/retry';

describe('user reads retry progress in their own language', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('user reads retry progress in English when the app language is English', () => {
        setLocale('en-US');

        expect(getRetryStatusMessage(2, 5)).toBe('Retrying... (2/5)');
    });
});
