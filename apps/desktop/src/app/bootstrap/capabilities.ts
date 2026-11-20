import { awaitAbortable } from '@/utils/abort';

export type StartupCapabilityName = 'built-in-tools' | 'built-in-bash' | 'model-metadata';
const AGENT_CAPABILITIES: readonly StartupCapabilityName[] = [
    'built-in-tools',
    'built-in-bash',
    'model-metadata',
];

/** Readiness belongs to a window lifetime; a failed optional warm-up remains best-effort. */
export function createStartupCapabilities(warn: (message: string, error: unknown) => void) {
    const capabilities = new Map<string, Promise<void>>();
    const lifetime = new AbortController();
    return Object.freeze({
        register(name: string, task: Promise<unknown>) {
            lifetime.signal.throwIfAborted();
            capabilities.set(
                name,
                task.then(
                    () => undefined,
                    (error: unknown) => {
                        try {
                            warn(`[Startup] Capability "${name}" failed to initialize`, error);
                        } catch {
                            /* Passive diagnostics cannot change readiness. */
                        }
                    }
                )
            );
        },
        isRegistered: (name: string) => capabilities.has(name),
        whenReady: (name: string) =>
            awaitAbortable(() => capabilities.get(name) ?? Promise.resolve(), lifetime.signal),
        waitForAgent: () =>
            awaitAbortable(
                () =>
                    Promise.all(
                        AGENT_CAPABILITIES.map(
                            (name) => capabilities.get(name) ?? Promise.resolve()
                        )
                    ).then(() => undefined),
                lifetime.signal
            ),
        dispose() {
            lifetime.abort();
            capabilities.clear();
        },
    });
}

export type StartupCapabilities = ReturnType<typeof createStartupCapabilities>;
