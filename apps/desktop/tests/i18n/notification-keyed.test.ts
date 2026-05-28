import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type MessageKey, t } from '@/i18n';
import { messages } from '@/i18n/messages';

const repoRoot = resolve(__dirname, '../..');

const STATIC_NOTIFICATION_FILES = [
    'src/components/MarkdownContent.vue',
    'src/views/SearchView/components/ConversationPanel/components/UserMessage.vue',
    'src/views/SearchView/components/ConversationPanel/components/AssistantMessage.vue',
    'src/views/SearchView/index.vue',
    'src/views/SearchView/composables/useSearchPage.ts',
    'src/views/SettingsView/components/General/index.vue',
];

const REQUIRED_KEYS = [
    'common.copy',
    'common.copied',
    'common.copyFailed',
    'notification.copy.copiedToClipboard',
    'notification.pinToggleFailed.title',
    'notification.pinToggleFailed.body',
    'notification.openSessionFailed.title',
    'notification.openSessionFailed.missing',
    'notification.openSessionFailed.generic',
    'notification.shortcutRegistrationFailed.title',
    'notification.shortcutRegistrationFailed.alreadyRegistered',
    'notification.shortcutRegistrationFailed.invalid',
    'notification.shortcutRegistrationFailed.unsupported',
    'notification.shortcutRegistrationFailed.generic',
] as const satisfies readonly MessageKey[];

describe('keyed static notifications', () => {
    it('has notification and copy keys in every locale', () => {
        for (const key of REQUIRED_KEYS) {
            expect(messages['zh-CN'][key], key).toBeTruthy();
            expect(messages['en-US'][key], key).toBeTruthy();
        }
    });

    it('renders copy notification bodies through keyed vue-i18n messages', () => {
        expect(t('common.copied')).toBe('已复制');
        expect(t('common.copyFailed')).toBe('复制失败');
    });

    it('does not use source-text notification fields for static app notifications', () => {
        const offenders = STATIC_NOTIFICATION_FILES.flatMap((file) => {
            const source = readFileSync(resolve(repoRoot, file), 'utf8');
            const matches = [...source.matchAll(/\b(?:titleSource|bodySource)\s*:/g)].map(
                (match) => `${file}:${source.slice(0, match.index).split('\n').length}`
            );
            return matches;
        });

        expect(offenders).toEqual([]);
    });
});
