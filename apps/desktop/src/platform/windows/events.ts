import { emit, emitTo, listen, once } from '@tauri-apps/api/event';

import { log } from '@/platform/diagnostics';

export function emitWindowEvent(target: string, event: string, payload: unknown): Promise<void> {
    return emitTo(target, event, payload);
}

export function listenWindowEvent(
    label: string,
    event: string,
    handler: (payload: unknown) => void
): Promise<() => void> {
    return listen<unknown>(event, ({ payload }) => handler(payload), {
        target: { kind: 'Window', label },
    });
}

export function createWindowEvent<Payload>(event: string) {
    return Object.freeze({
        on: (handler: (payload: Payload) => void) =>
            listen<Payload>(event, ({ payload }) => handler(payload)),
        emit: (payload: Payload) => emit(event, payload),
    });
}

/** Stateless native delivery; each caller declares the topics it can use. */
export function createWindowEvents<Events extends object>(input: {
    subscribe: readonly (keyof Events & string)[];
    publish: readonly (keyof Events & string)[];
}) {
    const subscriptions = new Set(input.subscribe);
    const publications = new Set(input.publish);
    function requireTopic(topics: ReadonlySet<string>, name: string) {
        if (!topics.has(name)) throw new Error('WINDOW_EVENT_UNAVAILABLE');
    }
    return Object.freeze({
        async emit<K extends keyof Events & string>(name: K, payload: Events[K]): Promise<void> {
            requireTopic(publications, name);
            try {
                await emit(name, payload);
            } catch (error) {
                log.error(`Failed to publish window event ${name}`, error);
                throw error;
            }
        },
        async on<K extends keyof Events & string>(
            name: K,
            callback: (payload: Events[K]) => void
        ): Promise<() => void> {
            requireTopic(subscriptions, name);
            try {
                return await listen<Events[K]>(name, (event) => callback(event.payload));
            } catch (error) {
                log.error(`Failed to subscribe to window event ${name}`, error);
                throw error;
            }
        },
        async once<K extends keyof Events & string>(
            name: K,
            callback: (payload: Events[K]) => void
        ): Promise<() => void> {
            requireTopic(subscriptions, name);
            try {
                return await once<Events[K]>(name, (event) => callback(event.payload));
            } catch (error) {
                log.error(`Failed to subscribe to window event ${name}`, error);
                throw error;
            }
        },
    });
}
