import type {
    SearchAction,
    SearchActionHandler,
    SearchActionOutcome,
    SearchActivationContext,
} from './contracts';
import { immutableSnapshot } from './snapshot';

export class SearchActionDispatcher {
    private readonly handlers = new Map<string, SearchActionHandler<SearchAction>>();

    constructor(private readonly parent?: SearchActionDispatcher) {}

    register<A extends SearchAction>(kind: A['kind'], handler: SearchActionHandler<A>) {
        if (!kind || this.handlers.has(kind)) {
            throw new Error(`Search action handler already registered or invalid: ${kind}`);
        }
        // Only the corresponding discriminant can reach this trusted domain handler.
        const registered = handler as SearchActionHandler<SearchAction>;
        this.handlers.set(kind, registered);
        return {
            dispose: () => {
                if (this.handlers.get(kind) === registered) this.handlers.delete(kind);
            },
        };
    }

    async dispatch<A extends SearchAction>(
        action: A,
        context: SearchActivationContext
    ): Promise<SearchActionOutcome> {
        if (context.signal.aborted) return { status: 'cancelled' };
        if (action.requiresConversation && !context.conversation)
            return { status: 'requires-conversation' };
        const handler = this.handlers.get(action.kind);
        if (!handler) return this.parent?.dispatch(action, context) ?? { status: 'unavailable' };
        const snapshot = Object.freeze({
            ...context,
            input: context.input
                ? Object.freeze({
                      text: context.input.text,
                      files: Object.freeze(
                          context.input.files.map((file) => Object.freeze({ ...file }))
                      ),
                  })
                : undefined,
            conversation: context.conversation
                ? Object.freeze({ ...context.conversation })
                : context.conversation,
        });
        return handler(immutableSnapshot(action), snapshot);
    }
}
