import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createVisualReplyActionDispatcher,
    dispatchVisualReplyLink,
    dispatchVisualReplyPrompt,
    registerVisualReplyHost,
} from '@/services/VisualReplyService/bridge';

afterEach(() => {
    registerVisualReplyHost({ sendPrompt: vi.fn(), openLink: vi.fn() })();
});

describe('when visual content asks the conversation host to act', () => {
    it('user receives no privileged actions from a dispatcher without capabilities', () => {
        const sendPrompt = vi.fn();
        const openLink = vi.fn();
        const dispatcher = createVisualReplyActionDispatcher({ sendPrompt, openLink });

        expect(dispatcher.dispatch({ type: 'send_prompt', value: 'continue' })).toBe(false);
        expect(dispatcher.dispatch({ type: 'open_link', value: 'https://example.com' })).toBe(
            false
        );
        expect(sendPrompt).not.toHaveBeenCalled();
        expect(openLink).not.toHaveBeenCalled();
    });

    it('user can continue the conversation with a normalized bounded prompt', () => {
        const sendPrompt = vi.fn();
        const dispose = registerVisualReplyHost({ sendPrompt, openLink: vi.fn() });

        expect(dispatchVisualReplyPrompt('  compare these results  ')).toBe(true);
        expect(sendPrompt).toHaveBeenCalledWith('compare these results');
        dispose();
        expect(dispatchVisualReplyPrompt('not sent')).toBe(false);
    });

    it('user cannot dispatch empty, non-text, or oversized prompts', () => {
        const sendPrompt = vi.fn();
        registerVisualReplyHost({ sendPrompt, openLink: vi.fn() });

        expect(dispatchVisualReplyPrompt('  ')).toBe(false);
        expect(dispatchVisualReplyPrompt(42)).toBe(false);
        expect(dispatchVisualReplyPrompt('x'.repeat(4001))).toBe(false);
        expect(sendPrompt).not.toHaveBeenCalled();
    });

    it('user can open only HTTP and HTTPS links', () => {
        const openLink = vi.fn();
        registerVisualReplyHost({ sendPrompt: vi.fn(), openLink });

        expect(dispatchVisualReplyLink('https://example.com/path')).toBe(true);
        expect(openLink).toHaveBeenCalledWith('https://example.com/path');
        expect(dispatchVisualReplyLink('javascript:alert(1)')).toBe(false);
        expect(dispatchVisualReplyLink('file:///etc/passwd')).toBe(false);
        expect(dispatchVisualReplyLink('https://user:pass@example.com')).toBe(false);
        expect(dispatchVisualReplyLink(`https://example.com/${'x'.repeat(2050)}`)).toBe(false);
    });
});
