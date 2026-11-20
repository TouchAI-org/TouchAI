import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** The caller owns its protocol; platform owns directed delivery and focus lifetime. */
export function createWindowChannel<T>(input: {
    event: string;
    label: string;
    parse(payload: unknown): T | null;
    validateSend(target: string, message: T): void;
}) {
    return {
        label: input.label,
        async send(target: string, message: T) {
            input.validateSend(target, message);
            if (target === '*') await emit(input.event, message);
            else await emitTo(target, input.event, message);
        },
        listen(handler: (message: T) => void) {
            return listen<unknown>(
                input.event,
                ({ payload }) => {
                    const message = input.parse(payload);
                    if (message) handler(message);
                },
                { target: { kind: 'Window', label: input.label } }
            );
        },
        async onFocus(handler: () => void): Promise<() => void> {
            try {
                return await getCurrentWindow().onFocusChanged(({ payload }) => {
                    if (payload) handler();
                });
            } catch {
                return () => undefined;
            }
        },
    };
}
