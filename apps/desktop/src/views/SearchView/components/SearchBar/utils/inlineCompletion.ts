import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

const inlineCompletionKey = new PluginKey<string>('inlineCompletion');

export function setInlineCompletion(view: EditorView, text: string): boolean {
    const previous = inlineCompletionKey.getState(view.state) ?? '';
    if (!text && !previous) return false;
    const { selection } = view.state;
    const next =
        view.editable &&
        !view.composing &&
        selection.empty &&
        selection.$from.parentOffset === selection.$from.parent.content.size
            ? text
            : '';
    if (previous === next) return false;
    view.dispatch(view.state.tr.setMeta(inlineCompletionKey, next).setMeta('addToHistory', false));
    return true;
}

export const InlineCompletion = Extension.create({
    name: 'inlineCompletion',
    addProseMirrorPlugins() {
        return [
            new Plugin<string>({
                key: inlineCompletionKey,
                state: {
                    init: () => '',
                    apply(transaction, previous) {
                        const next: unknown = transaction.getMeta(inlineCompletionKey);
                        if (typeof next === 'string') return next;
                        return transaction.docChanged || transaction.selectionSet ? '' : previous;
                    },
                },
                props: {
                    decorations(state) {
                        const text = inlineCompletionKey.getState(state);
                        if (!text) return null;
                        return DecorationSet.create(state.doc, [
                            Decoration.widget(
                                state.selection.from,
                                (view) => {
                                    const hint = view.dom.ownerDocument.createElement('span');
                                    hint.setAttribute('data-inline-completion', text);
                                    hint.setAttribute('aria-hidden', 'true');
                                    hint.contentEditable = 'false';
                                    return hint;
                                },
                                { key: text, side: 1, ignoreSelection: true }
                            ),
                        ]);
                    },
                    handleDOMEvents: {
                        compositionstart(view) {
                            setInlineCompletion(view, '');
                            return false;
                        },
                    },
                },
            }),
        ];
    },
});
