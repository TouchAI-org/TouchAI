import { t, tt } from '@/i18n';

export const toolMessages = {
    t: (key: string, values?: Record<string, string | number>) =>
        t(key as Parameters<typeof t>[0], values),
    tt,
};
