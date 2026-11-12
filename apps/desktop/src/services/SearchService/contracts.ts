export type SearchIntent = 'launcher' | 'file-reference' | 'skill-reference';
export type SearchGroup = 'shortcut' | 'miniapp' | 'file' | 'skill';
export type SearchInputKind = 'text' | 'file' | 'image';

/** Domain packages extend this discriminated shape with their own payloads. */
export interface SearchAction {
    readonly kind: string;
    readonly requiresConversation?: boolean;
}

export interface SearchResult<A extends SearchAction = SearchAction> {
    readonly id: string;
    readonly kind: string;
    readonly group: SearchGroup;
    readonly label: string;
    readonly description?: string;
    readonly iconSrc?: string;
    readonly disabled?: boolean;
    readonly primaryAction?: A;
    readonly completionAction?: A;
}

export interface SearchQuery {
    readonly query: string;
    readonly intent: SearchIntent;
    readonly limit?: number;
    /** Capability hints only; providers never receive draft contents or file handles. */
    readonly inputKinds?: readonly SearchInputKind[];
}

export interface SearchProviderRequest extends SearchQuery {
    readonly epoch: number;
    readonly limit: number;
    readonly cursor?: string;
    readonly signal: AbortSignal;
}

export interface SearchPage<R extends SearchResult = SearchResult> {
    readonly items: readonly R[];
    readonly nextCursor?: string;
    readonly total?: number;
    readonly totals?: Partial<Readonly<Record<SearchGroup, number>>>;
}

export interface SearchProvider<R extends SearchResult = SearchResult> {
    readonly id: string;
    readonly intents: readonly SearchIntent[];
    /** Ranking stays within this provider's groups; group order belongs to the host. */
    search(request: SearchProviderRequest): Promise<SearchPage<R>>;
}

export interface SearchProviderRegistration {
    invalidate(): void;
    dispose(): void;
    readonly isDisposed: boolean;
}

export interface SearchMatch<R extends SearchResult = SearchResult> {
    readonly key: string;
    readonly providerId: string;
    readonly generation: number;
    readonly epoch: number;
    readonly result: R;
}

export interface SearchProviderState {
    readonly providerId: string;
    readonly loading: boolean;
    readonly nextCursor?: string;
    readonly total: number;
    readonly totals?: Partial<Readonly<Record<SearchGroup, number>>>;
    readonly error?: unknown;
    readonly capped: boolean;
}

export interface SearchSnapshot {
    readonly epoch: number;
    readonly query: string;
    readonly intent: SearchIntent;
    readonly items: readonly SearchMatch[];
    readonly providers: readonly SearchProviderState[];
    readonly loading: boolean;
}

/** Host-side references; a launch adapter resolves IDs into restricted handles. */
export interface SearchInputFile {
    readonly id: string;
    readonly name: string;
    readonly kind: 'file' | 'image';
}

export interface SearchActivationContext {
    readonly query: string;
    readonly intent: SearchIntent;
    readonly epoch: number;
    readonly signal: AbortSignal;
    readonly input?: {
        readonly text?: string;
        readonly files: readonly SearchInputFile[];
    };
    readonly conversation?: { readonly sessionId: number } | null;
    readonly draftVersion?: number;
}

export type SearchActionOutcome = {
    readonly status:
        | 'completed'
        | 'started'
        | 'requires-conversation'
        | 'requires-permissions'
        | 'unavailable'
        | 'failed'
        | 'cancelled'
        | 'unsupported';
};

export type SearchActionHandler<A extends SearchAction> = (
    action: A,
    context: SearchActivationContext
) => SearchActionOutcome | Promise<SearchActionOutcome>;
