import { flushPromises } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { reactive } from 'vue';

import {
    SearchActionDispatcher,
    type SearchActivationContext,
    type SearchGroup,
    type SearchPage,
    SearchProviderRegistry,
    type SearchProviderRequest,
    type SearchResult,
} from '@/services/SearchService';

function result(id: string, group: SearchGroup = 'file'): SearchResult {
    return { id, kind: group, label: id, group, primaryAction: { kind: 'test.open' } };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolveValue, rejectValue) => {
        resolve = resolveValue;
        reject = rejectValue;
    });
    return { promise, resolve, reject };
}

function activation(): SearchActivationContext {
    return { query: 'query', intent: 'launcher', epoch: 1, signal: new AbortController().signal };
}

describe('given trusted providers with independent result pages', () => {
    it('user can return to the last completed query while the replacement is pending but cannot revive invalidated contributions', async () => {
        const registry = new SearchProviderRegistry();
        const pending = deferred<SearchPage>();
        const registration = registry.registerProvider({
            id: 'files',
            intents: ['launcher'],
            search({ query }) {
                return query === 'read'
                    ? Promise.resolve({ items: [result('read')] })
                    : pending.promise;
            },
        });
        const session = registry.createSession();
        await session.search({ query: 'read', intent: 'launcher' });
        const old = session.snapshot.items[0]!;
        const replacing = session.search({ query: 'readx', intent: 'launcher' });
        expect(session.restorePrevious({ query: 'read', intent: 'launcher' })).toBe(true);
        expect(session.resolve(old)).toBeNull();
        expect(session.resolve(session.snapshot.items[0]!)).not.toBeNull();
        await expect(replacing).resolves.toMatchObject({ stale: true });
        const other = session.search({ query: 'readx', intent: 'launcher' });
        registration.invalidate();
        expect(session.restorePrevious({ query: 'read', intent: 'launcher' })).toBe(false);
        session.cancel();
        await other;
        pending.resolve({ items: [] });
    });
    it('user can combine surface-owned files with shared providers without sharing file state', async () => {
        const registry = new SearchProviderRegistry();
        registry.registerProvider({
            id: 'apps',
            intents: ['launcher'],
            async search() {
                return { items: [result('app', 'miniapp')] };
            },
        });
        const local = {
            id: 'files',
            intents: ['launcher'] as const,
            async search() {
                return { items: [result('local')] };
            },
        };
        const first = registry.createSession([local]);
        const second = registry.createSession();
        await first.search({ query: 'a', intent: 'launcher' });
        await second.search({ query: 'a', intent: 'launcher' });
        expect(first.snapshot.items.map(({ result }) => result.id)).toEqual(['app', 'local']);
        expect(second.snapshot.items.map(({ result }) => result.id)).toEqual(['app']);
        first.dispose();
        expect(second.snapshot.items.map(({ result }) => result.id)).toEqual(['app']);
    });
    it('user sees host group order while each provider keeps its ranking and cursor', async () => {
        const registry = new SearchProviderRegistry();
        registry.registerProvider({
            id: 'files',
            intents: ['launcher'],
            async search({ cursor }) {
                return cursor === 'files:2'
                    ? { items: [result('file-2')], total: 4 }
                    : {
                          items: [result('shortcut', 'shortcut'), result('file-1')],
                          nextCursor: 'files:2',
                          total: 4,
                      };
            },
        });
        registry.registerProvider({
            id: 'apps',
            intents: ['launcher'],
            async search({ cursor }) {
                return cursor === 'apps:2'
                    ? { items: [result('app-2', 'miniapp')] }
                    : {
                          items: [result('z-app', 'miniapp'), result('a-app', 'miniapp')],
                          nextCursor: 'apps:2',
                      };
            },
        });
        const session = registry.createSession();
        await session.search({ query: 'a', intent: 'launcher' });
        expect(session.snapshot.items.map(({ result }) => result.id)).toEqual([
            'shortcut',
            'z-app',
            'a-app',
            'file-1',
        ]);
        await session.loadMore('apps');
        expect(session.snapshot.items.map(({ result }) => result.id)).toEqual([
            'shortcut',
            'z-app',
            'a-app',
            'app-2',
            'file-1',
        ]);
        expect(
            session.snapshot.providers.find((provider) => provider.providerId === 'files')
                ?.nextCursor
        ).toBe('files:2');
        await session.loadMore('files');
        expect(session.snapshot.items.map(({ result }) => result.id)).toEqual([
            'shortcut',
            'z-app',
            'a-app',
            'app-2',
            'file-1',
            'file-2',
        ]);
    });

    it('user gets only providers eligible for the current input intent', async () => {
        const registry = new SearchProviderRegistry();
        registry.registerProvider({
            id: 'apps',
            intents: ['launcher'],
            async search() {
                throw new Error('must not run');
            },
        });
        registry.registerProvider({
            id: 'files',
            intents: ['file-reference'],
            async search() {
                return { items: [result('file')] };
            },
        });
        const snapshot = await registry
            .createSession()
            .search({ query: 'file', intent: 'file-reference' });
        expect(snapshot.providers).toHaveLength(1);
        expect(snapshot.items.map(({ result }) => result.id)).toEqual(['file']);
    });

    it('user can search in two surfaces without cancelling the other surface', async () => {
        const registry = new SearchProviderRegistry();
        registry.registerProvider({
            id: 'files',
            intents: ['launcher'],
            async search({ query }) {
                return { items: [result(query)] };
            },
        });
        const first = registry.createSession();
        const second = registry.createSession();
        await Promise.all([
            first.search({ query: 'first', intent: 'launcher' }),
            second.search({ query: 'second', intent: 'launcher' }),
        ]);
        first.cancel();
        expect(second.snapshot.items[0]?.result.label).toBe('second');
        expect(second.resolve(second.snapshot.items[0]!)).not.toBeNull();
    });

    it('user moves on immediately when an obsolete provider ignores cancellation', async () => {
        const registry = new SearchProviderRegistry();
        const old = deferred<SearchPage>();
        let oldSignal: AbortSignal | undefined;
        registry.registerProvider({
            id: 'files',
            intents: ['launcher'],
            search({ query, signal }) {
                if (query === 'old') {
                    oldSignal = signal;
                    return old.promise;
                }
                return Promise.resolve({ items: [result('new')] });
            },
        });
        const session = registry.createSession();
        let obsolete: unknown;
        void session.search({ query: 'old', intent: 'launcher' }).then((value) => {
            obsolete = value;
        });
        await session.search({ query: 'new', intent: 'launcher' });
        await flushPromises();
        expect(oldSignal?.aborted).toBe(true);
        expect(obsolete).toMatchObject({ stale: true, items: [] });
        old.resolve({ items: [result('old')] });
        await flushPromises();
        expect(session.snapshot.items[0]?.result.label).toBe('new');
    });

    it('user sees one loading transition when starting a replacement query', async () => {
        const registry = new SearchProviderRegistry();
        const pending = deferred<SearchPage>();
        registry.registerProvider({
            id: 'files',
            intents: ['launcher'],
            search() {
                return pending.promise;
            },
        });
        const session = registry.createSession();
        const notifications: boolean[] = [];
        session.subscribe((snapshot) => notifications.push(snapshot.loading));
        const search = session.search({ query: 'x', intent: 'launcher' });
        expect(notifications).not.toContain(false);
        pending.resolve({ items: [result('x')] });
        await search;
        expect(notifications[notifications.length - 1]).toBe(false);
    });

    it('user loses obsolete actions immediately when a provider is invalidated', async () => {
        const registry = new SearchProviderRegistry();
        const replacement = deferred<SearchPage>();
        let revision = 0;
        const registration = registry.registerProvider({
            id: 'apps',
            intents: ['launcher'],
            async search() {
                return revision ? replacement.promise : { items: [result('app', 'miniapp')] };
            },
        });
        const session = registry.createSession();
        await session.search({ query: 'a', intent: 'launcher' });
        const old = session.snapshot.items[0]!;
        revision++;
        registration.invalidate();
        expect(session.resolve(old)).toBeNull();
        expect(session.snapshot.items).toEqual([]);
        replacement.resolve({ items: [result('updated', 'miniapp')] });
        await flushPromises();
        expect(session.snapshot.items[0]?.result.label).toBe('updated');
        expect(session.snapshot.items[0]?.generation).not.toBe(old.generation);
    });

    it('user can replace a disposed provider without accepting its late response', async () => {
        const registry = new SearchProviderRegistry();
        const old = deferred<SearchPage>();
        const registration = registry.registerProvider({
            id: 'apps',
            intents: ['launcher'],
            search: () => old.promise,
        });
        const session = registry.createSession();
        const search = session.search({ query: 'a', intent: 'launcher' });
        registration.dispose();
        registration.dispose();
        registration.invalidate();
        registry.registerProvider({
            id: 'apps',
            intents: ['launcher'],
            async search() {
                return { items: [result('new', 'miniapp')] };
            },
        });
        old.resolve({ items: [result('old', 'miniapp')] });
        await search;
        await flushPromises();
        expect(registration.isDisposed).toBe(true);
        expect(session.snapshot.items.map(({ result }) => result.id)).toEqual(['new']);
    });

    it('user can search healthy groups when another provider fails and recover on the next query', async () => {
        const registry = new SearchProviderRegistry();
        registry.registerProvider({
            id: 'files',
            intents: ['launcher'],
            async search({ query }) {
                if (query === 'broken') throw new Error('index unavailable');
                return { items: [result('file')] };
            },
        });
        registry.registerProvider({
            id: 'apps',
            intents: ['launcher'],
            async search() {
                return { items: [result('app', 'miniapp')] };
            },
        });
        const session = registry.createSession();
        await session.search({ query: 'broken', intent: 'launcher' });
        expect(session.snapshot.items.map(({ result }) => result.id)).toEqual(['app']);
        expect(
            session.snapshot.providers.find((provider) => provider.providerId === 'files')?.error
        ).toEqual(new Error('index unavailable'));
        await session.search({ query: 'fixed', intent: 'launcher' });
        expect(session.snapshot.items.map(({ result }) => result.id)).toEqual(['app', 'file']);
        expect(session.snapshot.providers.every((provider) => !provider.error)).toBe(true);
    });

    it('user retains a valid page when the next page contains an invalid result', async () => {
        const registry = new SearchProviderRegistry();
        registry.registerProvider({
            id: 'files',
            intents: ['launcher'],
            async search({ cursor }) {
                return cursor
                    ? {
                          items: [
                              result('new'),
                              { ...result('bad'), group: 'constructor' as SearchGroup },
                          ],
                      }
                    : { items: [result('first')], nextCursor: 'next', total: 3 };
            },
        });
        const session = registry.createSession();
        await session.search({ query: 'x', intent: 'launcher' });
        await session.loadMore();
        expect(session.snapshot.items.map(({ result }) => result.id)).toEqual(['first']);
        expect(session.snapshot.providers[0]?.error).toBeInstanceOf(Error);
    });

    it('user does not load the same cursor cycle indefinitely', async () => {
        const registry = new SearchProviderRegistry();
        registry.registerProvider({
            id: 'files',
            intents: ['launcher'],
            async search({ cursor }) {
                return {
                    items: [result(cursor ?? 'first')],
                    nextCursor: cursor === 'b' ? 'a' : cursor === 'a' ? 'b' : 'a',
                };
            },
        });
        const session = registry.createSession();
        await session.search({ query: 'x', intent: 'launcher' });
        await session.loadMore();
        await session.loadMore();
        expect(session.snapshot.providers[0]?.nextCursor).toBeUndefined();
        expect(session.snapshot.providers[0]?.error).toBeInstanceOf(Error);
        expect(session.snapshot.items.map(({ result }) => result.id)).toEqual(['first', 'a']);
    });

    it('user sees deduplicated rows when pages overlap', async () => {
        const registry = new SearchProviderRegistry();
        registry.registerProvider({
            id: 'files',
            intents: ['launcher'],
            async search({ cursor }) {
                return cursor
                    ? { items: [{ ...result('first'), label: 'updated' }, result('second')] }
                    : { items: [result('first')], nextCursor: 'next', total: 2 };
            },
        });
        const session = registry.createSession();
        await session.search({ query: 'x', intent: 'launcher' });
        await session.loadMore();
        expect(session.snapshot.items.map(({ result }) => result.label)).toEqual([
            'updated',
            'second',
        ]);
    });

    it('user cannot retain unbounded pages from a provider', async () => {
        const registry = new SearchProviderRegistry();
        registry.registerProvider({
            id: 'files',
            intents: ['launcher'],
            async search({ cursor }) {
                const page = Number(cursor ?? 0);
                return {
                    items: Array.from({ length: 2000 }, (_, index) => result(`${page}:${index}`)),
                    nextCursor: String(page + 1),
                };
            },
        });
        const session = registry.createSession();
        await session.search({ query: 'x', intent: 'launcher' });
        await session.loadMore();
        await session.loadMore();
        expect(session.snapshot.items).toHaveLength(5000);
        expect(session.snapshot.providers[0]).toMatchObject({
            capped: true,
            nextCursor: undefined,
        });
    });

    it('user receives a finite page request even when the requested limit is invalid', async () => {
        const registry = new SearchProviderRegistry();
        let requested: SearchProviderRequest | undefined;
        registry.registerProvider({
            id: 'files',
            intents: ['launcher'],
            async search(request) {
                requested = request;
                return { items: [] };
            },
        });
        await registry.createSession().search({ query: 'x', intent: 'launcher', limit: NaN });
        expect(requested?.limit).toBe(60);
    });

    it('user stops receiving results after a surface is disposed', async () => {
        const registry = new SearchProviderRegistry();
        const pending = deferred<SearchPage>();
        registry.registerProvider({
            id: 'files',
            intents: ['launcher'],
            search: () => pending.promise,
        });
        const session = registry.createSession();
        const search = session.search({ query: 'x', intent: 'launcher' });
        session.dispose();
        session.dispose();
        pending.resolve({ items: [result('late')] });
        await expect(search).resolves.toMatchObject({ stale: true });
        expect(session.snapshot.items).toEqual([]);
        await expect(session.search({ query: 'again', intent: 'launcher' })).rejects.toThrow(
            'disposed'
        );
    });
});

describe('given a selected typed result', () => {
    it('user pending activation is cancelled when its provider is invalidated', async () => {
        const registry = new SearchProviderRegistry();
        const registration = registry.registerProvider({
            id: 'apps',
            intents: ['launcher'],
            async search() {
                return { items: [result('app', 'miniapp')] };
            },
        });
        const session = registry.createSession();
        await session.search({ query: 'app', intent: 'launcher' });
        const dispatcher = new SearchActionDispatcher();
        const finish = deferred<void>();
        dispatcher.register('test.open', async (_action, context) => {
            await finish.promise;
            return { status: context.signal.aborted ? 'cancelled' : 'started' };
        });
        const launch = session.activate(
            session.snapshot.items[0]!,
            'primary',
            dispatcher,
            activation()
        );
        registration.invalidate();
        finish.resolve();
        await expect(launch).resolves.toEqual({ status: 'cancelled' });
    });
    it('user can activate a Vue-wrapped result using authoritative action data', async () => {
        const registry = new SearchProviderRegistry();
        registry.registerProvider({
            id: 'files',
            intents: ['launcher'],
            async search() {
                return { items: [result('file')] };
            },
        });
        const session = registry.createSession();
        await session.search({ query: 'file', intent: 'launcher' });
        const match = reactive({
            ...session.snapshot.items[0]!,
            result: { ...result('forged'), primaryAction: { kind: 'forged' } },
        });
        const dispatcher = new SearchActionDispatcher();
        dispatcher.register('test.open', () => ({ status: 'completed' }));
        await expect(session.activate(match, 'primary', dispatcher, activation())).resolves.toEqual(
            { status: 'completed' }
        );
    });

    it('user cannot launch an item by pressing Tab when no completion action exists', async () => {
        const registry = new SearchProviderRegistry();
        registry.registerProvider({
            id: 'apps',
            intents: ['launcher'],
            async search() {
                return { items: [result('app', 'miniapp')] };
            },
        });
        const session = registry.createSession();
        await session.search({ query: 'app', intent: 'launcher' });
        const dispatcher = new SearchActionDispatcher();
        dispatcher.register('test.open', () => {
            throw new Error('must not launch');
        });
        await expect(
            session.activate(session.snapshot.items[0]!, 'completion', dispatcher, activation())
        ).resolves.toEqual({ status: 'unsupported' });
    });

    it('user cannot activate an old or disabled result', async () => {
        const registry = new SearchProviderRegistry();
        registry.registerProvider({
            id: 'files',
            intents: ['launcher'],
            async search() {
                return { items: [{ ...result('file'), disabled: true }] };
            },
        });
        const session = registry.createSession();
        await session.search({ query: 'x', intent: 'launcher' });
        const old = session.snapshot.items[0]!;
        expect(session.resolve(old)).toBeNull();
        await session.search({ query: 'y', intent: 'launcher' });
        expect(session.resolve(old)).toBeNull();
    });

    it('user keeps the original action even if a consumer tries to mutate nested snapshot data', async () => {
        const registry = new SearchProviderRegistry();
        const action = { kind: 'test.open', parameters: { target: 'safe' } };
        registry.registerProvider({
            id: 'files',
            intents: ['launcher'],
            async search() {
                return { items: [{ ...result('file'), primaryAction: action }] };
            },
        });
        const session = registry.createSession();
        await session.search({ query: 'x', intent: 'launcher' });
        const snapshot = session.snapshot;
        action.parameters.target = 'provider-mutated';
        const exposed = snapshot.items[0]!.result.primaryAction as typeof action;
        expect(() => {
            exposed.parameters.target = 'consumer-mutated';
        }).toThrow();
        const dispatcher = new SearchActionDispatcher();
        let launched: string | undefined;
        dispatcher.register<typeof action>('test.open', (action) => {
            launched = action.parameters.target;
            return { status: 'completed' };
        });
        await session.activate(snapshot.items[0]!, 'primary', dispatcher, activation());
        expect(launched).toBe('safe');
    });
});

describe('given typed action handlers', () => {
    it('user can launch a shared contribution through surface-local action handling', async () => {
        const shared = new SearchActionDispatcher();
        const local = new SearchActionDispatcher(shared);
        shared.register('app.open', () => ({ status: 'started' }));
        local.register('file.open', () => ({ status: 'completed' }));
        await expect(local.dispatch({ kind: 'app.open' }, activation())).resolves.toEqual({
            status: 'started',
        });
        await expect(local.dispatch({ kind: 'file.open' }, activation())).resolves.toEqual({
            status: 'completed',
        });
    });
    it('user launches with an immutable explicit-input snapshot separate from search keywords', async () => {
        const dispatcher = new SearchActionDispatcher();
        const finished = deferred<void>();
        let received: SearchActivationContext | undefined;
        dispatcher.register('test.open', async (_action, context) => {
            await finished.promise;
            received = context;
            return { status: 'started' };
        });
        const input = {
            text: 'explicit text',
            files: [{ id: 'file-id', name: 'a.txt', kind: 'file' as const }],
        };
        const pending = dispatcher.dispatch(
            { kind: 'test.open' },
            { ...activation(), input, conversation: { sessionId: 7 } }
        );
        input.text = 'later';
        input.files[0]!.name = 'later';
        finished.resolve();
        await expect(pending).resolves.toEqual({ status: 'started' });
        expect(received?.input).toEqual({
            text: 'explicit text',
            files: [{ id: 'file-id', name: 'a.txt', kind: 'file' }],
        });
        expect(received?.query).toBe('query');
        expect(Object.isFrozen(received?.input?.files[0])).toBe(true);
    });

    it('user must explicitly choose a conversation before launching a conversation-only action', async () => {
        const dispatcher = new SearchActionDispatcher();
        dispatcher.register('test.open', () => {
            throw new Error('must not launch');
        });
        await expect(
            dispatcher.dispatch({ kind: 'test.open', requiresConversation: true }, activation())
        ).resolves.toEqual({ status: 'requires-conversation' });
    });

    it('user cannot start a cancelled activation', async () => {
        const dispatcher = new SearchActionDispatcher();
        const controller = new AbortController();
        controller.abort();
        await expect(
            dispatcher.dispatch(
                { kind: 'test.open' },
                { ...activation(), signal: controller.signal }
            )
        ).resolves.toEqual({ status: 'cancelled' });
    });

    it('user receives unavailable when a launch handler has been disposed', async () => {
        const dispatcher = new SearchActionDispatcher();
        const registration = dispatcher.register('test.open', () => ({ status: 'completed' }));
        registration.dispose();
        registration.dispose();
        await expect(dispatcher.dispatch({ kind: 'test.open' }, activation())).resolves.toEqual({
            status: 'unavailable',
        });
    });

    it('user cannot silently replace an existing provider or handler', () => {
        const registry = new SearchProviderRegistry();
        const provider = {
            id: 'files',
            intents: ['launcher'] as const,
            async search() {
                return { items: [] };
            },
        };
        registry.registerProvider(provider);
        expect(() => registry.registerProvider(provider)).toThrow('already registered');
        const dispatcher = new SearchActionDispatcher();
        dispatcher.register('test.open', () => ({ status: 'completed' }));
        expect(() => dispatcher.register('test.open', () => ({ status: 'completed' }))).toThrow(
            'already registered'
        );
    });
});
