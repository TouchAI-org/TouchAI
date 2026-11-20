import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { afterEach } from 'vitest';

import { searchApiKey } from '@/app/api/search/queries';
import {
    createSearchHost,
    loadFileReferenceSuggestions,
    type SearchHostOptions,
} from '@/modules/search';
import { native } from '@/platform/native';

const hosts: ReturnType<typeof createSearchHost>[] = [];

/** Real Search state; filesystem, query and opener boundaries stay controlled by each test. */
export function createTestSearchHost(options: Partial<SearchHostOptions> = {}) {
    const host = createSearchHost({
        files: native.quickSearch,
        openFile: openPath,
        revealFile: revealItemInDir,
        ...options,
        loadReferenceSuggestions:
            options.loadReferenceSuggestions ??
            ((limit, signal) => loadFileReferenceSuggestions(native.quickSearch, limit, signal)),
    });
    hosts.push(host);
    return host;
}

export function provideTestSearch(app: {
    provide: (key: typeof searchApiKey, api: ReturnType<typeof createSearchHost>['api']) => unknown;
}) {
    app.provide(searchApiKey, createTestSearchHost().api);
}

export function withTestSearch<
    T extends {
        quickSearch?: SearchHostOptions['files'];
        openPath?: SearchHostOptions['openFile'];
        loadReferenceSuggestions?: SearchHostOptions['loadReferenceSuggestions'];
    },
>(input: T) {
    return {
        ...input,
        search: createTestSearchHost({
            files: input.quickSearch ?? native.quickSearch,
            openFile: input.openPath ?? openPath,
            loadReferenceSuggestions: input.loadReferenceSuggestions,
        }).api,
    };
}

export function withTestSkillSearch<T extends object>(input: T) {
    return { ...input, search: createTestSearchHost().api };
}

afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
});
