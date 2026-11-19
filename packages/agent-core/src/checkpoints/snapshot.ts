import type { AgentCheckpoint, AgentMessage, OutputPart } from '../contracts/agent';

const snapshots = new WeakSet<object>();

export function snapshotValue<T>(value: T): T {
    if (value === null || typeof value !== 'object' || snapshots.has(value)) return value;
    const copy = (
        Array.isArray(value)
            ? value.map((item: unknown) => snapshotValue(item))
            : Object.fromEntries(
                  Object.entries(value).map(([key, item]) => [key, snapshotValue(item)])
              )
    ) as T & object;
    Object.freeze(copy);
    snapshots.add(copy);
    return copy;
}

export function isMessageSnapshot(message: AgentMessage): boolean {
    return snapshots.has(message);
}

export function snapshotMessages(messages: readonly AgentMessage[]): AgentMessage[] {
    return messages.map(snapshotValue);
}

export function snapshotParts(parts: readonly OutputPart[]): OutputPart[] {
    return parts
        .filter((part) => part.content || part.type === 'reasoning')
        .map((part) => ({
            ...part,
            ...(part.providerOptions
                ? { providerOptions: snapshotValue(part.providerOptions) }
                : {}),
        }));
}

export function snapshotCheckpoint(checkpoint: AgentCheckpoint): AgentCheckpoint {
    return {
        ...checkpoint,
        messages: snapshotMessages(checkpoint.messages),
        outputParts: snapshotParts(checkpoint.outputParts),
    };
}
