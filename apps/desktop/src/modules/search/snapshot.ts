/** Search contributions are plain host-owned data, never live plugin objects. */
export function immutableSnapshot<T>(value: T): T {
    const snapshot = structuredClone(value);
    const visited = new WeakSet<object>();
    function freeze(value: unknown) {
        if (!value || typeof value !== 'object' || visited.has(value)) return;
        visited.add(value);
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    freeze(snapshot);
    return snapshot;
}

/** Logical cancellation also settles providers backed by non-cancellable native IPC. */
export function awaitSearch<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
        // Cancellation is a normal query transition, including in Zone-instrumented renderers.
        const abort = () => resolve(undefined);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        pending.then(
            (value) => {
                signal.removeEventListener('abort', abort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', abort);
                reject(error);
            }
        );
    });
}
