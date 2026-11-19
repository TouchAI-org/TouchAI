import { assembleSearchWindow } from '@/app/composition/search';

export function initializeSearchWindow(label: string | null) {
    if (label !== 'main')
        return Object.freeze({ api: undefined, clipboard: undefined, dispose() {} });
    const host = assembleSearchWindow();
    return Object.freeze({ api: host.api, clipboard: host.clipboard, dispose: host.dispose });
}
