import type { ModelWithProvider } from '@database/queries/models';
import type { SessionEntity } from '@database/types';

import type { Index } from '@/services/AgentService/infrastructure/attachments';
import type { SessionTaskStatus } from '@/services/AgentService/task/types';
import type { InputHistorySnapshot, SessionMessage } from '@/types/session';

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
    prefetchModelDropdownData: () => void | Promise<void>;
    invalidateModelDropdownData: () => void;
    prepareModelDropdownOpen: (isCurrent?: () => boolean) => void | Promise<void>;
    selectModelFromDropdown: (
        modelDbId: number
    ) => SearchModelOverride | Promise<SearchModelOverride>;
    getModelDropdownAnchor: () => HTMLElement | null;
    getModelDropdownContext: () => SearchModelDropdownContext;
    focus: () => void | Promise<void>;
    loadActiveModel: () => void | Promise<void>;

    insertTextAtCursor: (text: string) => void;
    insertAttachmentAtCursor: (
        attachmentId: string,
        fileName: string,
        fileType: 'image' | 'file',
        preview?: string,
        alias?: string
    ) => void;

    captureInputHistorySnapshot: () => InputHistorySnapshot;
    restoreInputHistorySnapshot: (snapshot: InputHistorySnapshot) => string;
}

export interface QuickSearchHandle {
    open: () => void;
    close: () => void;
    settleInteraction: () => void;
    moveSelection: (direction: 'up' | 'down' | 'left' | 'right') => void;
    getHighlightedItem: () => unknown | null;
    openHighlightedItem: () => Promise<void>;
    triggerSearch: (query: string) => void;
    goToPage: (page: number) => void;
    goToNextPage: () => void;
    goToPreviousPage: () => void;
    openContextMenuForItem: (index: number) => void;
    openContextMenuForHighlightedItem: () => void;
    toggleViewMode: () => void;
    collapseToDefault: () => void;
    isContextMenuOpen: boolean;
    closeContextMenu: () => void;
}

export interface ConversationPanelHandle {
    getContentHeight: () => number;
    focus: () => void;
    revealLatestContent: () => void;
    scrollByDelta: (deltaY: number) => void;
    getHistoryAnchor: () => HTMLElement | null;
    isLatestContentVisible: () => boolean;
}

export interface SearchPageController {
    focusConversation: () => void;
    focusSearchInput: () => Promise<void>;
    loadActiveModel: () => Promise<void>;
    prefetchModelDropdownData: () => Promise<void>;
    invalidateModelDropdownData: () => void;
    prepareModelDropdownOpen: (isCurrent?: () => boolean) => Promise<void>;
    selectModelFromDropdown: (modelDbId: number) => Promise<SearchModelOverride>;
    getModelDropdownAnchor: () => HTMLElement | null;
    getModelDropdownContext: () => SearchModelDropdownContext;
    isQuickSearchOpen: () => boolean;
    isQuickSearchItemHighlighted: () => boolean;
    openQuickSearch: () => void;
    closeQuickSearch: () => void;
    settleQuickSearchInteraction: () => void;
    moveQuickSearchSelection: (direction: 'up' | 'down' | 'left' | 'right') => void;
    openHighlightedQuickSearchItem: () => Promise<void>;
    triggerQuickSearch: (query: string) => void;
    goToPageQuickSearch: (page: number) => void;
    goToNextPageQuickSearch: () => void;
    goToPreviousPageQuickSearch: () => void;
    openQuickSearchContextMenu: () => void;
    toggleQuickSearchView: () => void;
    collapseQuickSearch: () => void;
    isQuickSearchContextMenuOpen: () => boolean;
    closeQuickSearchContextMenu: () => void;
}

export interface PendingRequest {
    query: string;
    attachments: Index[];
    inputSnapshot?: InputHistorySnapshot;
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
    models: ModelWithProvider[];
}

export interface SearchDraftState {
    queryText: string;
    attachments: Index[];
    modelOverride: SearchModelOverride;
}

export interface SearchViewContext {
    draft: SearchDraftState;
    quickSearchOpen: boolean;
    cursor: SearchCursorContext;
    modelDropdown: SearchModelDropdownState;
    sessionHistory: SessionMessage[];
}

export interface ModelDropdownItem {
    id: number;
    modelId: string;
    name: string;
    providerId: number;
    providerName: string;
    reasoning: number;
    tool_call: number;
    modalities: string | null;
    attachment: number;
    open_weights: number;
}

export interface ModelDropdownData {
    activeModelId: string;
    activeProviderId: number | null;
    selectedModelId: string;
    selectedProviderId: number | null;
    searchQuery: string;
    toggleShortcut: string | null;
    models?: ModelDropdownItem[];
}

export interface SessionHistorySessionItem extends SessionEntity {
    displayStatus: Exclude<SessionTaskStatus, 'cancelled'> | null;
}

export interface SessionHistoryData {
    sessions: SessionHistorySessionItem[];
    activeSessionId: number | null;
    searchQuery: string;
    isLoading: boolean;
    toggleShortcut: string | null;
}
