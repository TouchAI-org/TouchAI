import { type App, createApp, nextTick } from 'vue';

export interface MountedComposable<T> {
    result: T;
    unmount: () => void;
}

export async function mountComposable<T>(factory: () => T): Promise<MountedComposable<T>> {
    let result: T | undefined;

    const app: App = createApp({
        setup() {
            result = factory();
            return () => null;
        },
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    app.mount(host);

    await nextTick();

    return {
        result: result as T,
        unmount: () => {
            app.unmount();
            host.remove();
        },
    };
}
