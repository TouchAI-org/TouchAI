import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { getRetryStatusMessage } from '@/services/AgentService/execution/retry';

describe('AgentService retry i18n', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('uses English retry status when the active locale is English', () => {
        setLocale('en-US');

        expect(getRetryStatusMessage(2, 5)).toBe('Retrying... (2/5)');
    });
});
