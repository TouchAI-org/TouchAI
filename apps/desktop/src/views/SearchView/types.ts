import type { ModelWithProvider } from '@database/queries/models';
import type { SessionEntity } from '@database/types';
import type { QuickShortcutItem } from '@services/NativeService';

import type { SelectableReasoningLevel } from '@/services/AgentService/contracts/reasoning';
import type { Index } from '@/services/AgentService/infrastructure/attachments';
import type { SelectedSkill } from '@/services/AgentService/skills';
import type { SessionTaskStatus } from '@/services/AgentService/task/types';
import type { SearchActivationContext } from '@/services/SearchService';
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
    insertSkillAtCursor: (skill: SelectedSkill) => void;
    insertAttachmentAtCursor: (
        attachmentId: string,
        fileName: string,
        fileType: 'image' | 'file',
        preview?: string,
        alias?: string,
        options?: { focus?: boolean }
    ) => void;
    isSkillAutocompleteOpen: () => boolean;
    isSkillAutocompleteActive: () => boolean;
    closeSkillAutocomplete: () => void;
    isFileAutocompleteOpen?: () => boolean;
    closeFileAutocomplete?: () => void;
    completeFileReference?: (index?: number) => boolean;

    captureInputHistorySnapshot: () => InputHistorySnapshot;
    captureSearchActivationInput?: () => NonNullable<SearchActivationContext['input']>;
    restoreInputHistorySnapshot: (snapshot: InputHistorySnapshot) => string;
}

export interface QuickSearchHandle {
    getContentHeight: () => number;
    open: () => void;
    close: () => void;
    settleInteraction: () => void;
    moveSelection: (direction: 'up' | 'down' | 'left' | 'right') => boolean;
    getHighlightedItem: () => unknown | null;
    getReferenceCandidate: (index?: number, expectedQuery?: string) => QuickShortcutItem | null;
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
    isSkillAutocompleteOpen: () => boolean;
    isSkillAutocompleteActive: () => boolean;
    closeSkillAutocomplete: () => void;
    isFileAutocompleteOpen?: () => boolean;
    hasInputContent: () => boolean;
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
    reasoningLevel?: SelectableReasoningLevel;
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
    providerLogo?: string;
    reasoningLevels?: SelectableReasoningLevel[];
    reasoning: number;
    tool_call: number;
    modalities: string | null;
    attachment: number;
    open_weights: number;
}

export interface ModelDropdownData {
    reasoningLevel?: SelectableReasoningLevel;
    reservedShortcuts?: (string | null)[];
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
