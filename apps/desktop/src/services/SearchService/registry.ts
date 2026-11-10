import type { SearchActionDispatcher } from './actions';
import type {
    SearchActionOutcome,
    SearchActivationContext,
    SearchGroup,
    SearchMatch,
    SearchProvider,
    SearchProviderRegistration,
    SearchQuery,
    SearchSnapshot,
} from './contracts';
import { awaitSearch, immutableSnapshot } from './snapshot';

const GROUP_ORDER: Record<SearchGroup, number> = { shortcut: 0, miniapp: 1, file: 2, skill: 3 };
const MAX_PAGE_ITEMS = 2000;
const MAX_RETAINED_ITEMS = 5000;
const MAX_PAGES = 100;

interface RegisteredProvider {
    provider: SearchProvider;
    generation: number;
}

interface ProviderResults {
    registration: RegisteredProvider;
    generation: number;
    controller: AbortController;
    items: SearchMatch[];
    loading: boolean;
    nextCursor?: string;
    total: number;
    totals?: Partial<Record<SearchGroup, number>>;
    error?: unknown;
    pages: number;
    capped: boolean;
    cursors: Set<string>;
}

export class SearchProviderRegistry {
    private readonly providers = new Map<string, RegisteredProvider>();
    private readonly listeners = new Set<(id: string) => void>();
    private generation = 0;

    registerProvider(provider: SearchProvider): SearchProviderRegistration {
        if (!provider.id || this.providers.has(provider.id)) {
            throw new Error(`Search provider already registered or invalid: ${provider.id}`);
        }
        const entry = { provider, generation: ++this.generation };
        this.providers.set(provider.id, entry);
        this.notify(provider.id);
        let disposed = false;
        return {
            get isDisposed() {
                return disposed;
            },
            invalidate: () => {
                if (disposed) return;
                entry.generation = ++this.generation;
                this.notify(provider.id);
            },
            dispose: () => {
                if (disposed) return;
                disposed = true;
                this.providers.delete(provider.id);
                this.notify(provider.id);
            },
        };
    }

    createSession(localProviders: readonly SearchProvider[] = []): SearchSession {
        const ids = new Set<string>();
        const locals = localProviders.map((provider) => {
            if (!provider.id || ids.has(provider.id) || this.providers.has(provider.id))
                throw new Error('Duplicate session search provider');
            ids.add(provider.id);
            return { provider, generation: ++this.generation };
        });
        return new SearchSession(this, locals);
    }

    entries(): readonly RegisteredProvider[] {
        return [...this.providers.values()];
    }

    subscribe(listener: (id: string) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private notify(id: string) {
        for (const listener of this.listeners) listener(id);
    }
}

export class SearchSession {
    private epoch = 0;
    private query: SearchQuery | null = null;
    private readonly results = new Map<string, ProviderResults>();
    private readonly listeners = new Set<(snapshot: SearchSnapshot) => void>();
    private readonly unsubscribe: () => void;
    private disposed = false;
    private previous: { query: SearchQuery; results: Map<string, ProviderResults> } | null = null;

    constructor(
        private readonly registry: SearchProviderRegistry,
        private readonly locals: readonly RegisteredProvider[] = []
    ) {
        this.unsubscribe = registry.subscribe((id) => this.providerChanged(id));
    }

    get snapshot(): SearchSnapshot {
        const providers = [...this.results.entries()].sort(([a], [b]) => a.localeCompare(b));
        return {
            epoch: this.epoch,
            query: this.query?.query ?? '',
            intent: this.query?.intent ?? 'launcher',
            items: providers
                .flatMap(([, state]) => state.items)
                .sort((a, b) => GROUP_ORDER[a.result.group] - GROUP_ORDER[b.result.group]),
            providers: providers.map(([providerId, state]) => ({
                providerId,
                loading: state.loading,
                nextCursor: state.nextCursor,
                total: state.total,
                totals: state.totals,
                error: state.error,
                capped: state.capped,
            })),
            loading: providers.some(([, state]) => state.loading),
        };
    }

    subscribe(listener: (snapshot: SearchSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async search(query: SearchQuery): Promise<SearchSnapshot & { stale: boolean }> {
        if (this.disposed) throw new Error('Search session is disposed');
        if (
            this.query &&
            this.results.size &&
            [...this.results.values()].every((state) => !state.loading && !state.error)
        ) {
            this.previous = { query: this.query, results: new Map(this.results) };
        }
        this.clear();
        this.query = {
            ...query,
            limit: Number.isFinite(query.limit)
                ? Math.max(1, Math.min(Math.floor(query.limit!), MAX_PAGE_ITEMS))
                : 60,
            inputKinds: query.inputKinds ? [...query.inputKinds] : undefined,
        };
        const epoch = this.epoch;
        const pending = [
            ...this.registry
                .entries()
                .filter(
                    ({ provider }) =>
                        !this.locals.some((entry) => entry.provider.id === provider.id)
                ),
            ...this.locals,
        ]
            .filter(({ provider }) => provider.intents.includes(query.intent))
            .map((entry) => this.startProvider(entry));
        const states = [...this.results.values()];
        this.publish();
        await Promise.all(pending);
        return epoch === this.epoch && states.every((state) => !state.controller.signal.aborted)
            ? { ...this.snapshot, stale: false }
            : {
                  epoch,
                  query: query.query,
                  intent: query.intent,
                  items: [],
                  providers: [],
                  loading: false,
                  stale: true,
              };
    }

    async loadMore(providerId?: string): Promise<void> {
        await Promise.all(
            [...this.results.entries()]
                .filter(
                    ([id, state]) =>
                        (!providerId || id === providerId) && state.nextCursor && !state.loading
                )
                .map(([id, state]) => this.fetchPage(id, state, state.nextCursor))
        );
    }

    restorePrevious(query: SearchQuery): boolean {
        const previous = this.previous;
        if (
            this.disposed ||
            !previous ||
            previous.query.query !== query.query ||
            previous.query.intent !== query.intent ||
            (query.limit !== undefined && previous.query.limit !== query.limit) ||
            JSON.stringify(previous.query.inputKinds ?? []) !==
                JSON.stringify(query.inputKinds ?? [])
        )
            return false;
        const current = new Set([...this.registry.entries(), ...this.locals]);
        if (
            [...previous.results.values()].some(
                (state) =>
                    !current.has(state.registration) ||
                    state.generation !== state.registration.generation
            )
        )
            return false;
        this.clear();
        this.query = previous.query;
        for (const [id, state] of previous.results) {
            this.results.set(id, {
                ...state,
                controller: new AbortController(),
                items: state.items.map((item) => Object.freeze({ ...item, epoch: this.epoch })),
            });
        }
        this.previous = null;
        this.publish();
        return true;
    }

    resolve(match: SearchMatch): SearchMatch | null {
        if (match.epoch !== this.epoch || this.disposed) return null;
        const state = this.results.get(match.providerId);
        if (
            !state ||
            state.generation !== state.registration.generation ||
            match.generation !== state.generation
        )
            return null;
        return state.items.find((item) => item.key === match.key && !item.result.disabled) ?? null;
    }

    async activate(
        match: SearchMatch,
        operation: 'primary' | 'completion',
        dispatcher: SearchActionDispatcher,
        context: Omit<SearchActivationContext, 'query' | 'epoch' | 'intent'>
    ): Promise<SearchActionOutcome> {
        const current = this.resolve(match);
        if (!current || !this.query) return { status: 'unavailable' };
        const action =
            operation === 'primary'
                ? current.result.primaryAction
                : current.result.completionAction;
        if (!action) return { status: 'unsupported' };
        const controller = new AbortController();
        const signals = [context.signal, this.results.get(current.providerId)!.controller.signal];
        const abort = () => controller.abort();
        // AbortSignal.any is newer than the desktop's Chrome 105 build target.
        for (const signal of signals) {
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
        }
        try {
            return await dispatcher.dispatch(action, {
                ...context,
                signal: controller.signal,
                query: this.query.query,
                intent: this.query.intent,
                epoch: this.epoch,
            });
        } finally {
            for (const signal of signals) signal.removeEventListener('abort', abort);
        }
    }

    cancel() {
        this.previous = null;
        this.clear();
        this.publish();
    }

    private clear() {
        this.epoch++;
        this.query = null;
        for (const state of this.results.values()) state.controller.abort();
        this.results.clear();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribe();
        this.cancel();
        this.listeners.clear();
    }

    private providerChanged(id: string) {
        if (this.locals.some((entry) => entry.provider.id === id)) return;
        this.previous = null;
        const old = this.results.get(id);
        old?.controller.abort();
        this.results.delete(id);
        const entry = this.registry.entries().find(({ provider }) => provider.id === id);
        if (entry && this.query && entry.provider.intents.includes(this.query.intent)) {
            void this.startProvider(entry);
        }
        this.publish();
    }

    private startProvider(entry: RegisteredProvider): Promise<void> {
        const state: ProviderResults = {
            registration: entry,
            generation: entry.generation,
            controller: new AbortController(),
            items: [],
            loading: false,
            total: 0,
            pages: 0,
            capped: false,
            cursors: new Set(),
        };
        this.results.set(entry.provider.id, state);
        return this.fetchPage(entry.provider.id, state);
    }

    private async fetchPage(id: string, state: ProviderResults, cursor?: string) {
        if (!this.query) return;
        const epoch = this.epoch;
        const request = {
            ...this.query,
            limit: this.query.limit ?? 60,
            epoch,
            cursor,
            signal: state.controller.signal,
        };
        const current = () =>
            !state.controller.signal.aborted &&
            epoch === this.epoch &&
            this.results.get(id) === state &&
            state.generation === state.registration.generation;
        state.loading = true;
        state.error = undefined;
        this.publish();
        try {
            const page = await awaitSearch(
                state.registration.provider.search(request),
                request.signal
            );
            if (!current()) return;
            if (!page || !Array.isArray(page.items) || page.items.length > MAX_PAGE_ITEMS)
                throw new Error('Search provider page exceeds its bound');
            if (
                page.nextCursor !== undefined &&
                (typeof page.nextCursor !== 'string' ||
                    !page.nextCursor ||
                    page.nextCursor === cursor ||
                    state.cursors.has(page.nextCursor))
            )
                throw new Error('Search provider cursor did not advance');
            if (page.total !== undefined && (!Number.isSafeInteger(page.total) || page.total < 0))
                throw new Error('Invalid search provider total');
            if (
                page.totals &&
                Object.entries(page.totals).some(
                    ([group, total]) =>
                        !Object.prototype.hasOwnProperty.call(GROUP_ORDER, group) ||
                        !Number.isSafeInteger(total) ||
                        total < 0
                )
            )
                throw new Error('Invalid search provider group total');
            const snapshots = page.items.map((result) => {
                if (
                    !result.id ||
                    !result.kind ||
                    typeof result.label !== 'string' ||
                    !Object.prototype.hasOwnProperty.call(GROUP_ORDER, result.group)
                )
                    throw new Error('Invalid search result');
                return immutableSnapshot(result);
            });
            const byId = new Map(state.items.map((item) => [item.result.id, item]));
            for (const result of snapshots) {
                if (!byId.has(result.id) && byId.size >= MAX_RETAINED_ITEMS) break;
                byId.set(
                    result.id,
                    Object.freeze({
                        key: JSON.stringify([id, result.id]),
                        providerId: id,
                        generation: state.generation,
                        epoch,
                        result,
                    })
                );
            }
            if (cursor) state.cursors.add(cursor);
            state.items = [...byId.values()];
            state.pages++;
            state.capped = byId.size >= MAX_RETAINED_ITEMS || state.pages >= MAX_PAGES;
            state.nextCursor = state.capped ? undefined : page.nextCursor;
            state.total = Math.max(page.total ?? state.total, state.items.length);
            state.totals = page.totals ? Object.freeze({ ...page.totals }) : state.totals;
        } catch (error) {
            if (current()) {
                state.error = error;
                state.nextCursor = undefined;
            }
        } finally {
            if (current()) {
                state.loading = false;
                this.publish();
            }
        }
    }

    private publish() {
        if (!this.listeners.size) return;
        const snapshot = this.snapshot;
        for (const listener of this.listeners) listener(snapshot);
    }
}
