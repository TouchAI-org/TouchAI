import { type App, createApp, nextTick } from 'vue';

import { provideTestAnalytics } from './analyticsWindow';
import { provideTestSearch } from './searchHost';
import { createTestWindowPresentation } from './windowPresentation';

export interface MountedComposable<T> {
    result: T;
    unmount: () => void;
}

export async function mountComposable<T>(
    factory: () => T,
    configure?: (app: App) => void
): Promise<MountedComposable<T>> {
    let result: T | undefined;

    const app: App = createApp({
        setup() {
            result = factory();
            return () => null;
        },
    });
    (await createTestWindowPresentation()).provide(app);
    provideTestSearch(app);
    provideTestAnalytics(app);
    configure?.(app);

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
