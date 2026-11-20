import { SearchActionDispatcher } from './actions';
import type {
    FileSearchItem,
    FileSearchReader,
    SearchAction,
    SearchActionHandler,
    SearchApi,
    SearchFilePresentation,
    SearchProvider,
    SearchSessionApi,
} from './contracts';
import { createFileSearchProvider, type FileOpenAction } from './files';
import { SearchProviderRegistry, type SearchSession } from './registry';
import { createSkillSearchProvider, type SkillReferenceAction } from './skills';

export interface SearchHostOptions {
    files: FileSearchReader & Partial<SearchFilePresentation>;
    revealFile?(path: string): Promise<void>;
    openFile(path: string): Promise<void>;
    recordClick?(query: string, path: string): void;
    loadReferenceSuggestions?(limit: number, signal: AbortSignal): Promise<FileSearchItem[]>;
    providers?: readonly SearchProvider[];
    actions?: readonly { kind: string; execute: SearchActionHandler<SearchAction> }[];
}

/** Surfaces receive query and activation capabilities; the host owns registrations. */
export function createSearchHost(options: SearchHostOptions) {
    const registry = new SearchProviderRegistry();
    const actions = new SearchActionDispatcher();
    const createSession = registry.createSession.bind(registry);
    const registrations = (options.providers ?? []).map((provider) =>
        registry.registerProvider(provider)
    );
    for (const action of options.actions ?? []) actions.register(action.kind, action.execute);
    const sessions = new Set<SearchSessionApi>();
    let disposed = false;

    function scope(session: SearchSession, dispatcher: SearchActionDispatcher): SearchSessionApi {
        const api = Object.freeze<SearchSessionApi>({
            get snapshot() {
                return session.snapshot;
            },
            subscribe: session.subscribe.bind(session),
            search: session.search.bind(session),
            loadMore: session.loadMore.bind(session),
            restorePrevious: session.restorePrevious.bind(session),
            resolve: session.resolve.bind(session),
            activate: (match, operation, context) =>
                session.activate(match, operation, dispatcher, context),
            cancel: session.cancel.bind(session),
            dispose() {
                session.dispose();
                sessions.delete(api);
            },
        });
        sessions.add(api);
        return api;
    }
    function assertLive() {
        if (disposed) throw new Error('SEARCH_HOST_UNAVAILABLE');
    }
    const api = Object.freeze<SearchApi>({
        async getFileStatus() {
            assertLive();
            if (!options.files.getStatus) throw new Error('SEARCH_CAPABILITY_UNAVAILABLE');
            return options.files.getStatus();
        },
        async prepareFileIndex(force) {
            assertLive();
            if (!options.files.prepareIndex) throw new Error('SEARCH_CAPABILITY_UNAVAILABLE');
            return options.files.prepareIndex(force);
        },
        async getImageThumbnails(paths, size) {
            assertLive();
            if (!options.files.getImageThumbnails) throw new Error('SEARCH_CAPABILITY_UNAVAILABLE');
            return options.files.getImageThumbnails(paths, size);
        },
        async getShortcutIcons(paths, size) {
            assertLive();
            if (!options.files.getShortcutIcons) throw new Error('SEARCH_CAPABILITY_UNAVAILABLE');
            return options.files.getShortcutIcons(paths, size);
        },
        async revealFile(path) {
            assertLive();
            if (!options.revealFile) throw new Error('SEARCH_CAPABILITY_UNAVAILABLE');
            return options.revealFile(path);
        },
        openFileSession(input = {}) {
            assertLive();
            const dispatcher = new SearchActionDispatcher(actions);
            dispatcher.register<FileOpenAction>('file.open', async (action, context) => {
                options.recordClick?.(context.query, action.path);
                input.recordClick?.(context.query, action.path);
                await options.openFile(action.path);
                return { status: 'completed' };
            });
            return scope(
                createSession([
                    createFileSearchProvider(options.files, {
                        ...input,
                        loadReferenceSuggestions: options.loadReferenceSuggestions,
                    }),
                ]),
                dispatcher
            );
        },
        openSkillSession(input) {
            assertLive();
            const dispatcher = new SearchActionDispatcher();
            dispatcher.register<SkillReferenceAction>('skill.reference', (action) =>
                input.select(action.skill)
            );
            return scope(
                createSession([createSkillSearchProvider(input.catalog, input.selected)]),
                dispatcher
            );
        },
    });
    return Object.freeze({
        api,
        registerProvider(provider: SearchProvider) {
            assertLive();
            const registration = registry.registerProvider(provider);
            registrations.push(registration);
            return registration;
        },
        registerAction<A extends SearchAction>(kind: A['kind'], execute: SearchActionHandler<A>) {
            assertLive();
            return actions.register(kind, execute);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const session of [...sessions]) session.dispose();
            for (const registration of registrations) registration.dispose();
        },
    });
}
