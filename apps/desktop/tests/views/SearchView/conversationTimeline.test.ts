// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import type { SessionMessage } from '@/types/session';
import ConversationTimeline from '@/views/SearchView/components/ConversationPanel/components/ConversationTimeline.vue';

function message(id: string, role: SessionMessage['role'], content: string): SessionMessage {
    return { id, role, content } as SessionMessage;
}

const conversation: SessionMessage[] = [
    message('m1', 'user', 'How do I deploy this app?'),
    message('a1', 'assistant', 'Build it first.'),
    message('m2', 'user', 'And then?'),
    message('a2', 'assistant', 'Then ship it.'),
];

function mountTimeline(messages: SessionMessage[] = conversation) {
    return mount(ConversationTimeline, {
        props: {
            messages,
            containerHeight: 600,
            scrollTop: 0,
            scrollHeight: 2000,
            clientHeight: 600,
        },
        attachTo: document.body,
    });
}

beforeEach(() => {
    setLocale('zh-CN');
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('user navigates a long conversation', () => {
    it('user gets one marker per question, spaced down the rail', () => {
        const wrapper = mountTimeline();

        const markers = wrapper.findAll('.timeline-marker');
        expect(markers).toHaveLength(2);
        expect(markers[0]!.attributes('style')).toContain('top: 20px');
        // The rail spans containerHeight - top offset - padding, so the last
        // marker sits at the far end of that span.
        expect(markers[1]!.attributes('style')).toContain('top: 522px');
    });

    it('user sees no timeline for a single-question conversation', () => {
        const wrapper = mountTimeline([message('m1', 'user', 'Only question')]);

        expect(wrapper.find('.conversation-timeline').exists()).toBe(false);
    });

    it('user sees the question preview when hovering a marker', () => {
        const wrapper = mountTimeline();
        const markers = wrapper.findAll('.timeline-marker');

        expect(markers[0]!.attributes('title')).toBe('How do I deploy this app?');
        expect(markers[0]!.find('.marker-tooltip').text()).toBe('How do I deploy this app?');
        expect(markers[1]!.attributes('title')).toBe('And then?');
    });

    it('user sees a long question shortened in the preview', () => {
        const long = 'x'.repeat(120);
        const wrapper = mountTimeline([
            message('m1', 'user', long),
            message('m2', 'user', 'short'),
        ]);

        const preview = wrapper.findAll('.timeline-marker')[0]!.attributes('title')!;
        expect(preview.length).toBeLessThan(long.length);
    });

    it('user jumps to a question by clicking its marker', async () => {
        const wrapper = mountTimeline();

        await wrapper.findAll('.timeline-marker')[1]!.trigger('click');

        expect(wrapper.emitted('jumpToMessage')).toEqual([['m2']]);
    });

    it('user jumps to a question from the keyboard', async () => {
        const wrapper = mountTimeline();
        const marker = wrapper.findAll('.timeline-marker')[0]!;

        await marker.trigger('keydown', { key: 'Enter' });
        await marker.trigger('keydown', { key: ' ' });

        expect(wrapper.emitted('jumpToMessage')).toEqual([['m1'], ['m1']]);
    });

    it('user is told which question a marker jumps to by assistive technology', () => {
        const wrapper = mountTimeline();

        expect(wrapper.findAll('.timeline-marker')[0]!.attributes('aria-label')).toContain(
            'How do I deploy this app?'
        );
    });

    it('user sees the marker of the question closest to the middle of the view', async () => {
        const first = document.createElement('div');
        first.dataset.messageId = 'm1';
        Object.defineProperty(first, 'offsetTop', { value: 0 });
        Object.defineProperty(first, 'offsetHeight', { value: 100 });
        const second = document.createElement('div');
        second.dataset.messageId = 'm2';
        Object.defineProperty(second, 'offsetTop', { value: 900 });
        Object.defineProperty(second, 'offsetHeight', { value: 100 });
        document.body.append(first, second);

        const wrapper = mountTimeline();

        // The viewport centre is scrollTop + clientHeight / 2 = 300, which is
        // nearer the first question.
        await vi.advanceTimersByTimeAsync(60);
        expect(wrapper.findAll('.timeline-marker')[0]!.classes()).toContain('active');

        await wrapper.setProps({ scrollTop: 700 });
        await vi.advanceTimersByTimeAsync(60);

        // Now the centre is at 1000, which is nearer the second question.
        expect(wrapper.findAll('.timeline-marker')[1]!.classes()).toContain('active');
        expect(wrapper.findAll('.timeline-marker')[0]!.classes()).not.toContain('active');
    });

    it('user sees no marker highlighted while no question is rendered', async () => {
        const wrapper = mountTimeline();

        await vi.advanceTimersByTimeAsync(60);

        expect(wrapper.findAll('.timeline-marker.active')).toHaveLength(0);
    });

    it('user sees the timeline keep working after a scroll', async () => {
        const wrapper = mountTimeline();

        await wrapper.setProps({ scrollTop: 400 });
        await vi.advanceTimersByTimeAsync(60);
        await wrapper.findAll('.timeline-marker')[1]!.trigger('click');

        expect(wrapper.emitted('jumpToMessage')).toEqual([['m2']]);
    });

    it('user sees the timeline gone once the conversation panel unmounts', () => {
        const wrapper = mountTimeline();

        wrapper.unmount();

        expect(document.querySelector('.conversation-timeline')).toBeNull();
    });

    it('user hears the jump action described in the app language', async () => {
        const chinese = mountTimeline();
        expect(chinese.findAll('.timeline-marker')[0]!.attributes('aria-label')).toContain(
            '跳转到消息'
        );
        chinese.unmount();

        setLocale('en-US');
        const english = mountTimeline();
        await flushPromises();

        expect(english.findAll('.timeline-marker')[0]!.attributes('aria-label')).toContain(
            'Jump to message'
        );
    });

    it('user sees the markers follow the panel height when the window is resized', async () => {
        const wrapper = mountTimeline();
        expect(wrapper.findAll('.timeline-marker')[1]!.attributes('style')).toContain('top: 522px');

        await wrapper.setProps({ containerHeight: 900 });

        // A taller panel stretches the rail instead of squeezing the markers.
        expect(wrapper.findAll('.timeline-marker')[1]!.attributes('style')).toContain('top: 822px');
    });
});
