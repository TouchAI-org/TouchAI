// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { AiMessage } from '../contracts/protocol';

// Only snapshots created here are trusted, not arbitrary shallow-frozen callers.
const snapshots = new WeakSet<AiMessage>();

/** Clone JSON containers once; share immutable strings, including large attachment payloads. */
function snapshotValue<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    const copy = (
        Array.isArray(value)
            ? value.map((item: unknown) => snapshotValue(item))
            : Object.fromEntries(
                  Object.entries(value).map(([key, item]) => [key, snapshotValue(item)])
              )
    ) as T & object;
    Object.freeze(copy);
    return copy;
}

export function isMessageSnapshot(message: AiMessage): boolean {
    return snapshots.has(message);
}

/** A new appendable array whose completed messages can safely be shared across checkpoints. */
export function snapshotAiMessages(messages: AiMessage[]): AiMessage[] {
    return messages.map((message) => {
        if (snapshots.has(message)) return message;
        const snapshot = snapshotValue(message);
        snapshots.add(snapshot);
        return snapshot;
    });
}
