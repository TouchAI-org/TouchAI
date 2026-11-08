// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

export interface VisualReplyHost {
    sendPrompt: (text: string) => void;
    openLink: (url: string) => void;
}

export type VisualReplyActionRequest =
    | { type: 'send_prompt'; value: unknown }
    | { type: 'open_link'; value: unknown };

export interface VisualReplyCapabilityProfile {
    conversationPrompt?: boolean;
    externalLink?: boolean;
}

export interface VisualReplyActionDispatcher {
    dispatch: (action: VisualReplyActionRequest) => boolean;
    dispose: () => void;
}

export function createVisualReplyActionDispatcher(
    host: VisualReplyHost,
    capabilities: VisualReplyCapabilityProfile = {}
): VisualReplyActionDispatcher {
    let disposed = false;

    return {
        dispatch(action) {
            if (disposed) return false;

            if (action.type === 'send_prompt') {
                if (!capabilities.conversationPrompt || typeof action.value !== 'string') {
                    return false;
                }
                const text = action.value.trim();
                if (!text || text.length > 4000) return false;
                host.sendPrompt(text);
                return true;
            }

            if (
                !capabilities.externalLink ||
                typeof action.value !== 'string' ||
                action.value.length > 2048
            ) {
                return false;
            }

            try {
                const url = new URL(action.value);
                if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
                    return false;
                }
                host.openLink(url.href);
                return true;
            } catch {
                return false;
            }
        },
        dispose() {
            disposed = true;
        },
    };
}

let dispatcher: VisualReplyActionDispatcher | null = null;

export function registerVisualReplyHost(nextHost: VisualReplyHost): () => void {
    const nextDispatcher = createVisualReplyActionDispatcher(nextHost, {
        conversationPrompt: true,
        externalLink: true,
    });
    dispatcher?.dispose();
    dispatcher = nextDispatcher;
    return () => {
        if (dispatcher === nextDispatcher) dispatcher = null;
        nextDispatcher.dispose();
    };
}

export function dispatchVisualReplyPrompt(text: unknown): boolean {
    return dispatcher?.dispatch({ type: 'send_prompt', value: text }) ?? false;
}

export function dispatchVisualReplyLink(value: unknown): boolean {
    return dispatcher?.dispatch({ type: 'open_link', value }) ?? false;
}
