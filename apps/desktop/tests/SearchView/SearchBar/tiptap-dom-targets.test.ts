import { describe, expect, it } from 'vitest';

import {
    findSearchTagChip,
    isBlankEditorAreaTarget,
    isSearchTagDomTarget,
    resolveMouseEventTarget,
} from '@/views/SearchView/components/SearchBar/utils/tiptap';

/**
 * The search bar decides what a click or a mousedown means by inspecting the DOM target.
 * These helpers are that decision, so they are tested against real DOM nodes rather than
 * against a mocked element: a chip, a close button, the blank editor host, and everything
 * else.
 */
function chip(): HTMLElement {
    const el = document.createElement('span');
    el.setAttribute('data-search-tag', 'attachment');
    return el;
}

describe('user clicks inside the search bar', () => {
    it('user gets the tag chip recognised when clicking the chip itself', () => {
        expect(findSearchTagChip(chip())).not.toBeNull();
        expect(isSearchTagDomTarget(chip())).toBe(true);
    });

    it('user gets the tag chip recognised when clicking its close button', () => {
        const host = chip();
        const close = document.createElement('span');
        close.setAttribute('data-tag-close', '');
        host.appendChild(close);

        // The click lands on the inner button, not the chip, so the lookup must walk up.
        expect(findSearchTagChip(close)).toBe(host);
        expect(isSearchTagDomTarget(close)).toBe(true);
    });

    it('user gets no chip when clicking ordinary text', () => {
        const text = document.createElement('p');
        text.textContent = 'hello';

        expect(findSearchTagChip(text)).toBeNull();
        expect(isSearchTagDomTarget(text)).toBe(false);
    });

    it('user gets nothing when the event carries no target at all', () => {
        expect(findSearchTagChip(null)).toBeFalsy();
        expect(isSearchTagDomTarget(null)).toBe(false);
    });

    it('user gets the blank editor area recognised for the editor host', () => {
        const host = document.createElement('div');
        host.className = 'search-bar-editor-host';

        expect(isBlankEditorAreaTarget(host)).toBe(true);
    });

    it('user gets the blank editor area recognised for the tiptap root', () => {
        const root = document.createElement('div');
        root.className = 'tiptap';

        expect(isBlankEditorAreaTarget(root)).toBe(true);
    });

    it('user gets no blank area when clicking a chip inside the editor', () => {
        expect(isBlankEditorAreaTarget(chip())).toBe(false);
    });

    it('user gets the element behind a text node as the click target', () => {
        const paragraph = document.createElement('p');
        const text = document.createTextNode('hello');
        paragraph.appendChild(text);
        document.body.appendChild(paragraph);

        const event = { target: text } as unknown as MouseEvent;

        // Browsers report the text node for a click on plain text; the handler needs an element.
        expect(resolveMouseEventTarget(event)).toBe(paragraph);

        paragraph.remove();
    });

    it('user gets the element itself when the click lands on an element', () => {
        const button = document.createElement('button');
        const event = { target: button } as unknown as MouseEvent;

        expect(resolveMouseEventTarget(event)).toBe(button);
    });

    it('user gets no target when the click came from somewhere that is not a node', () => {
        const event = { target: { nodeType: 9 } } as unknown as MouseEvent;

        // Anything that is neither an element nor a text node resolves to nothing.
        expect(resolveMouseEventTarget(event)).toBeFalsy();
    });
});
