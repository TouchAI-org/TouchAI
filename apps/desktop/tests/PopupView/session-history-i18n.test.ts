import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { setLocale } from '@/i18n';
import { createDomLocalizer } from '@/i18n/domLocalizer';
import SessionHistoryPopover from '@/views/PopupView/components/SessionHistoryPopover/index.vue';

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@services/EventService', () => ({
    AppEvent: {
        POPUP_SESSION_OPEN: 'popup-session-history-open-session',
        POPUP_SESSION_SEARCH_QUERY_CHANGE: 'popup-session-history-search-query-change',
    },
    eventService: {
        emit: vi.fn(),
    },
}));

describe('SessionHistoryPopover i18n', () => {
    beforeEach(() => {
        setLocale('zh-CN');
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-20T12:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders dynamic labels in English when the active locale is English', () => {
        setLocale('en-US');

        const wrapper = mount(SessionHistoryPopover, {
            props: {
                data: {
                    activeSessionId: 1,
                    searchQuery: '',
                    isLoading: false,
                    sessions: [
                        {
                            id: 1,
                            session_id: 'session-1',
                            title: '',
                            created_at: '2026-05-20 08:00:00',
                            updated_at: '2026-05-20 09:00:00',
                            last_message_at: '2026-05-20 09:00:00',
                            last_message_preview: '',
                            model: '',
                            provider_id: null,
                            message_count: 1,
                            status_badge_dismissed_turn_id: null,
                            pending_terminal_status: null,
                            pinned_at: null,
                            archived_at: null,
                            displayStatus: 'waiting_approval',
                        },
                    ],
                },
            },
        });

        expect(wrapper.text()).toContain('Today');
        expect(wrapper.text()).toContain('Untitled session');
        expect(wrapper.text()).toContain('Default model');
        expect(wrapper.get('input').attributes('placeholder')).toBe('Search titles or messages');
        expect(wrapper.find('.history-session-status-indicator').attributes('title')).toBe(
            'Session is waiting for tool approval'
        );
    });

    it('updates status titles after switching locale without remounting', async () => {
        const wrapper = mount(SessionHistoryPopover, {
            props: {
                data: {
                    activeSessionId: 1,
                    searchQuery: '',
                    isLoading: false,
                    sessions: [
                        {
                            id: 1,
                            session_id: 'session-1',
                            title: 'Demo',
                            created_at: '2026-05-20 08:00:00',
                            updated_at: '2026-05-20 09:00:00',
                            last_message_at: '2026-05-20 09:00:00',
                            last_message_preview: '',
                            model: '',
                            provider_id: null,
                            message_count: 1,
                            status_badge_dismissed_turn_id: null,
                            pending_terminal_status: null,
                            pinned_at: null,
                            archived_at: null,
                            displayStatus: 'completed',
                        },
                    ],
                },
            },
        });

        expect(wrapper.find('.history-session-status-indicator').attributes('title')).toBe(
            '会话已完成，点击后会隐藏该状态'
        );

        setLocale('en-US');
        await nextTick();

        expect(wrapper.find('.history-session-status-indicator').attributes('title')).toBe(
            'Session completed. Open it to hide this status'
        );
    });

    it('uses keyed translations for every session status title', () => {
        setLocale('en-US');

        const wrapper = mount(SessionHistoryPopover, {
            props: {
                data: {
                    activeSessionId: 1,
                    searchQuery: '',
                    isLoading: false,
                    sessions: [
                        {
                            id: 1,
                            session_id: 'session-1',
                            title: 'Running',
                            created_at: '2026-05-20 08:00:00',
                            updated_at: '2026-05-20 09:00:00',
                            last_message_at: '2026-05-20 09:00:00',
                            last_message_preview: '',
                            model: '',
                            provider_id: null,
                            message_count: 1,
                            status_badge_dismissed_turn_id: null,
                            pending_terminal_status: null,
                            pinned_at: null,
                            archived_at: null,
                            displayStatus: 'running',
                        },
                        {
                            id: 2,
                            session_id: 'session-2',
                            title: 'Waiting',
                            created_at: '2026-05-20 08:00:00',
                            updated_at: '2026-05-20 09:01:00',
                            last_message_at: '2026-05-20 09:01:00',
                            last_message_preview: '',
                            model: '',
                            provider_id: null,
                            message_count: 1,
                            status_badge_dismissed_turn_id: null,
                            pending_terminal_status: null,
                            pinned_at: null,
                            archived_at: null,
                            displayStatus: 'waiting_approval',
                        },
                        {
                            id: 3,
                            session_id: 'session-3',
                            title: 'Completed',
                            created_at: '2026-05-20 08:00:00',
                            updated_at: '2026-05-20 09:02:00',
                            last_message_at: '2026-05-20 09:02:00',
                            last_message_preview: '',
                            model: '',
                            provider_id: null,
                            message_count: 1,
                            status_badge_dismissed_turn_id: null,
                            pending_terminal_status: null,
                            pinned_at: null,
                            archived_at: null,
                            displayStatus: 'completed',
                        },
                        {
                            id: 4,
                            session_id: 'session-4',
                            title: 'Failed',
                            created_at: '2026-05-20 08:00:00',
                            updated_at: '2026-05-20 09:03:00',
                            last_message_at: '2026-05-20 09:03:00',
                            last_message_preview: '',
                            model: '',
                            provider_id: null,
                            message_count: 1,
                            status_badge_dismissed_turn_id: null,
                            pending_terminal_status: null,
                            pinned_at: null,
                            archived_at: null,
                            displayStatus: 'failed',
                        },
                    ],
                },
            },
        });

        expect(
            wrapper
                .findAll('.history-session-status-indicator')
                .map((indicator) => indicator.attributes('title'))
        ).toEqual([
            'Session is generating content',
            'Session is waiting for tool approval',
            'Session completed. Open it to hide this status',
            'Session failed. Open it to hide this status',
        ]);
    });

    it('renders empty and loading states in English', async () => {
        setLocale('en-US');

        const wrapper = mount(SessionHistoryPopover, {
            props: {
                data: {
                    activeSessionId: null,
                    searchQuery: 'missing',
                    isLoading: true,
                    sessions: [],
                },
            },
        });

        expect(wrapper.text()).toContain('Searching sessions...');

        await wrapper.setProps({
            data: {
                activeSessionId: null,
                searchQuery: 'missing',
                isLoading: false,
                sessions: [],
            },
        });

        expect(wrapper.text()).toContain('No matching sessions');
        expect(wrapper.text()).toContain('Try a shorter keyword');
    });

    it('opts session title and preview text out of global DOM localization', () => {
        setLocale('en-US');

        const wrapper = mount(SessionHistoryPopover, {
            props: {
                data: {
                    activeSessionId: 1,
                    searchQuery: '',
                    isLoading: false,
                    sessions: [
                        {
                            id: 1,
                            session_id: 'session-1',
                            title: '设置',
                            created_at: '2026-05-20 08:00:00',
                            updated_at: '2026-05-20 09:00:00',
                            last_message_at: '2026-05-20 09:00:00',
                            last_message_preview: '关闭',
                            model: '',
                            provider_id: null,
                            message_count: 1,
                            displayStatus: null,
                            status_badge_dismissed_turn_id: null,
                            pending_terminal_status: null,
                            pinned_at: null,
                            archived_at: null,
                        },
                    ],
                },
            },
        });
        const localizer = createDomLocalizer(wrapper.element);

        localizer.translateNow();
        localizer.stop();

        expect(wrapper.get('input').attributes('placeholder')).toBe('Search titles or messages');
        expect(wrapper.get('.history-session-title').attributes('data-no-i18n')).toBe('true');
        expect(wrapper.get('.history-session-title').attributes('translate')).toBe('no');
        expect(wrapper.get('.history-session-title').text()).toBe('设置');
        expect(wrapper.get('.history-session-preview').attributes('data-no-i18n')).toBe('true');
        expect(wrapper.get('.history-session-preview').attributes('translate')).toBe('no');
        expect(wrapper.get('.history-session-preview').text()).toBe('关闭');
    });

    it('uses the configured toggle shortcut and ignores the old default', () => {
        const wrapper = mount(SessionHistoryPopover, {
            props: {
                data: {
                    activeSessionId: null,
                    searchQuery: '',
                    isLoading: false,
                    toggleShortcut: 'Alt+H',
                    sessions: [],
                },
            },
        });
        const handleKeyDown = (
            wrapper.vm as unknown as { handleKeyDown: (event: KeyboardEvent) => void }
        ).handleKeyDown;

        handleKeyDown(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true }));
        expect(wrapper.emitted('close')).toBeUndefined();

        handleKeyDown(new KeyboardEvent('keydown', { key: 'h', altKey: true }));
        expect(wrapper.emitted('close')).toHaveLength(1);
    });

    it('does not close from the old history shortcut when the shortcut is disabled', () => {
        const wrapper = mount(SessionHistoryPopover, {
            props: {
                data: {
                    activeSessionId: null,
                    searchQuery: '',
                    isLoading: false,
                    toggleShortcut: null,
                    sessions: [],
                },
            },
        });
        const handleKeyDown = (
            wrapper.vm as unknown as { handleKeyDown: (event: KeyboardEvent) => void }
        ).handleKeyDown;

        handleKeyDown(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true }));

        expect(wrapper.emitted('close')).toBeUndefined();
    });
});
