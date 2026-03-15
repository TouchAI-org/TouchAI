import type { ConversationMessage } from '@composables/useAgent';
import type { ModelWithProvider } from '@database/queries/models';
import type { Index } from '@services/AiService/attachments';

import type {
    SearchCursorContext,
    SearchModelDropdownState,
    SearchModelOverride,
} from './components/SearchBar/types';

export type {
    SearchCursorContext,
    SearchModelDropdownState,
    SearchModelOverride,
} from './components/SearchBar/types';

export interface SearchBarHandle {
    prepareModelDropdownOpen: () => void | Promise<void>;
    resetModelDropdownState: () => void;
    selectModelFromDropdown: (
        modelDbId: number
    ) => SearchModelOverride | Promise<SearchModelOverride>;
    getModelDropdownAnchor: () => HTMLElement | null;
    getModelDropdownContext: () => SearchModelDropdownContext;
    focus: () => void | Promise<void>;
    loadActiveModel: () => void | Promise<void>;
}

export interface QuickSearchHandle {
    open: () => void;
    close: () => void;
    syncClosedState: () => void;
    moveSelection: (direction: 'up' | 'down' | 'left' | 'right') => void;
    getHighlightedItem: () => unknown | null;
    openHighlightedItem: () => Promise<void>;
    triggerSearch: (query: string) => void;
}

export interface ConversationPanelHandle {
    focus: () => void;
}

export interface SearchPageController {
    focusConversation: () => void;
    focusSearchInput: () => Promise<void>;
    loadActiveModel: () => Promise<void>;
    prepareModelDropdownOpen: () => Promise<void>;
    resetModelDropdownState: () => void;
    selectModelFromDropdown: (modelDbId: number) => Promise<SearchModelOverride>;
    getModelDropdownAnchor: () => HTMLElement | null;
    getModelDropdownContext: () => SearchModelDropdownContext;
    isQuickSearchOpen: () => boolean;
    isQuickSearchItemHighlighted: () => boolean;
    openQuickSearch: () => void;
    closeQuickSearch: () => void;
    moveQuickSearchSelection: (direction: 'up' | 'down' | 'left' | 'right') => void;
    openHighlightedQuickSearchItem: () => Promise<void>;
    triggerQuickSearch: (query: string) => void;
}

export interface PendingRequest {
    query: string;
    attachments: Index[];
    modelId?: string;
    providerId?: number;
}

export interface SearchModelCapabilities {
    supportsImages: boolean;
    supportsFiles: boolean;
}

export interface SearchModelDropdownContext {
    activeModelId: string | null;
    activeProviderId: number | null;
    selectedModelId: string | null;
    selectedProviderId: number | null;
    searchQuery: string;
    models: ModelWithProvider[];
}

export interface SearchDraftState {
    queryText: string;
    attachments: Index[];
    modelOverride: SearchModelOverride;
}

export type SearchOverlayState =
    | 'idle'
    | 'quick-search-open'
    | 'model-dropdown-preparing'
    | 'waiting-layout-stable'
    | 'model-dropdown-open';

export interface SearchViewContext {
    draft: SearchDraftState;
    quickSearchOpen: boolean;
    cursor: SearchCursorContext;
    modelDropdown: SearchModelDropdownState;
    overlay: SearchOverlayState;
    conversationHistory: ConversationMessage[];
}
