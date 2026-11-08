import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import VisualReplyFrame from '@/components/VisualReplyFrame.vue';
import { VISUAL_REPLY_THEME_CHANGE_EVENT } from '@/services/VisualReplyService/theme';

const wrappers: VueWrapper[] = [];
const createSrcdoc = vi.fn((source: string, nonce: string) => `${source}:${nonce}`);
const postMessage = vi.fn();

function render(source = '<p>Artifact</p>') {
    const wrapper = mount(VisualReplyFrame, {
        props: { source, createSrcdoc },
    });
    Object.defineProperty(wrapper.get('iframe').element, 'contentWindow', {
        configurable: true,
        value: window,
    });
    wrappers.push(wrapper);
    return wrapper;
}

function sendFrameMessage(
    wrapper: VueWrapper,
    data: { channel: string; nonce: string; type: string; value: unknown }
): void {
    const frame = wrapper.get('iframe').element as HTMLIFrameElement;
    const event = new MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: frame.contentWindow });
    window.dispatchEvent(event);
}

afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    createSrcdoc.mockClear();
    postMessage.mockClear();
    vi.restoreAllMocks();
});

describe('when an isolated visual reply is displayed', () => {
    it('user keeps the running visual when the host theme changes', async () => {
        const wrapper = render();
        await nextTick();
        vi.spyOn(window, 'postMessage').mockImplementation(postMessage);
        const srcdoc = (wrapper.get('iframe').element as HTMLIFrameElement).srcdoc;
        const nonce = srcdoc.slice(srcdoc.lastIndexOf(':') + 1);

        sendFrameMessage(wrapper, {
            channel: 'touchai-visual-reply',
            nonce,
            type: 'ready',
            value: true,
        });
        await wrapper.vm.$nextTick();
        window.dispatchEvent(new Event(VISUAL_REPLY_THEME_CHANGE_EVENT));

        expect((wrapper.get('iframe').element as HTMLIFrameElement).srcdoc).toBe(srcdoc);
        expect(createSrcdoc).toHaveBeenCalledTimes(1);
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'theme', channel: 'touchai-visual-reply' }),
            '*'
        );
    });

    it('user receives one ready event, bounded resize updates, script errors, and disposal', async () => {
        const wrapper = render();
        await nextTick();
        const srcdoc = (wrapper.get('iframe').element as HTMLIFrameElement).srcdoc;
        const nonce = srcdoc.slice(srcdoc.lastIndexOf(':') + 1);

        sendFrameMessage(wrapper, {
            channel: 'touchai-visual-reply',
            nonce,
            type: 'ready',
            value: true,
        });
        sendFrameMessage(wrapper, {
            channel: 'touchai-visual-reply',
            nonce,
            type: 'ready',
            value: true,
        });
        sendFrameMessage(wrapper, {
            channel: 'touchai-visual-reply',
            nonce,
            type: 'resize',
            value: 1300,
        });
        sendFrameMessage(wrapper, {
            channel: 'touchai-visual-reply',
            nonce,
            type: 'error',
            value: 'script failed',
        });
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted('ready')).toHaveLength(1);
        expect(wrapper.emitted('resize')).toEqual([[900]]);
        expect(wrapper.emitted('error')).toEqual([['script failed']]);
        expect(wrapper.get('[role="alert"]').text()).toContain('script failed');
        wrapper.unmount();
        expect(wrapper.emitted('dispose')).toHaveLength(1);
    });

    it('user sees an error when a document cannot be constructed', async () => {
        const wrapper = mount(VisualReplyFrame, {
            props: {
                source: '<p>Bad</p>',
                createSrcdoc: () => {
                    throw new Error('unsupported document');
                },
            },
        });
        await nextTick();
        Object.defineProperty(wrapper.get('iframe').element, 'contentWindow', {
            configurable: true,
            value: window,
        });
        wrappers.push(wrapper);
        await wrapper.vm.$nextTick();

        expect(wrapper.get('[role="alert"]').text()).toContain('unsupported document');
        expect(wrapper.emitted('error')).toEqual([['unsupported document']]);
    });
});
