/** Scoped aggregation for the shipped WebView, which predates AbortSignal.any. */
export function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]) {
    const sources = [...new Set(signals.filter((signal): signal is AbortSignal => !!signal))];
    const controller = new AbortController();
    const listeners = new Map<AbortSignal, () => void>();
    const dispose = () => {
        for (const [source, listener] of listeners) source.removeEventListener('abort', listener);
        listeners.clear();
    };
    for (const source of sources) {
        const abort = () => {
            controller.abort(source.reason);
            dispose();
        };
        if (source.aborted) {
            abort();
            break;
        }
        listeners.set(source, abort);
        source.addEventListener('abort', abort, { once: true });
    }
    return { signal: controller.signal, dispose };
}

/** Detach the caller on abort while still observing late native/I/O rejection. */
export function awaitAbortable<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return action();
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (result: { value: T } | { error: unknown }) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', abort);
            if ('error' in result) reject(result.error);
            else resolve(result.value);
        };
        const abort = () => finish({ error: signal.reason });
        signal.addEventListener('abort', abort, { once: true });
        try {
            void action().then(
                (value) => finish({ value }),
                (error) => finish({ error })
            );
        } catch (error) {
            finish({ error });
        }
    });
}
