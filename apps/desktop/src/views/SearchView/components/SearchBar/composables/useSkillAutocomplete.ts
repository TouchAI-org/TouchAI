import { computed, getCurrentScope, onScopeDispose, ref } from 'vue';

import { nextResultIndex } from '@/components/ui/result-panel/navigation';
import {
    discoverSkills,
    type SelectedSkill,
    type SkillMetadata,
} from '@/services/AgentService/skills';
import { normalizeSkillPath } from '@/services/AgentService/skills/path';
import { SearchActionDispatcher, SearchProviderRegistry } from '@/services/SearchService';
import {
    createSkillSearchProvider,
    filterSkillCandidates,
    type SkillReferenceAction,
    skillSearchItem,
} from '@/services/SearchService/skills';

import { handleAutocompleteKeyDown, resolveAutocompleteCompletion } from '../utils/autocomplete';

export { filterSkillCandidates } from '@/services/SearchService/skills';

export interface SkillAutocompleteTrigger {
    query: string;
    token: string;
    suffix: string;
}

export interface SkillPickerState {
    listId: string;
    query: string;
    loading: boolean;
    error: boolean;
    candidates: SkillMetadata[];
    highlightedIndex: number;
}

export interface UseSkillAutocompleteOptions {
    discoverSkills?: () => Promise<SkillMetadata[]>;
    autoSelectFirst?: () => boolean;
    getSelectedSkills: () => SelectedSkill[];
    onSelect: (skill: SelectedSkill, trigger: SkillAutocompleteTrigger) => void;
}

const SKILL_TRIGGER_PATTERN = /(?:^|[\s\ufffc])([$/]([\p{L}\p{N}_.:-]*))$/u;

export function resolveSkillTrigger(
    textBeforeCursor: string,
    textAfterCursor = ''
): SkillAutocompleteTrigger | null {
    const match = textBeforeCursor.match(SKILL_TRIGGER_PATTERN);
    const suffix = textAfterCursor.split(/[\s\ufffc]/u, 1)[0] ?? '';
    if (!match?.[1] || !SKILL_TRIGGER_PATTERN.test(match[1] + suffix)) {
        return null;
    }

    return {
        query: match[2] ?? '',
        token: match[1],
        suffix,
    };
}

export function containsSkillQuery(text: string): boolean {
    // Match whole tokens: /usr is a query, but /usr/local must remain a file search.
    return text.split(/[\s\ufffc]+/u).some((token) => resolveSkillTrigger(token) !== null);
}

export function useSkillAutocomplete(options: UseSkillAutocompleteOptions) {
    const loadSkills = options.discoverSkills ?? discoverSkills;
    const isLoading = ref(false);
    const isRevalidating = ref(false);
    const hasCompletedQuery = ref(false);
    const query = ref('');
    const activeTrigger = ref<SkillAutocompleteTrigger | null>(null);
    const candidates = ref<SkillMetadata[]>([]);
    const highlightedIndex = ref(-1);
    const atTextEnd = ref(true);
    const error = ref(false);
    let refreshId = 0;
    let catalogRequest: Promise<SkillMetadata[]> | null = null;
    let catalog: SkillMetadata[] | null = null;
    const session = new SearchProviderRegistry().createSession([
        createSkillSearchProvider(loadCatalog, options.getSelectedSkills),
    ]);
    const actions = new SearchActionDispatcher();
    actions.register<SkillReferenceAction>('skill.reference', (action) => {
        const trigger = activeTrigger.value;
        if (!trigger || isLoading.value || error.value) return { status: 'unavailable' };
        options.onSelect(action.skill, trigger);
        close();
        return { status: 'completed' };
    });
    if (getCurrentScope()) onScopeDispose(() => session.dispose());

    const highlightedSkill = computed(() => candidates.value[highlightedIndex.value] ?? null);
    const completion = computed(() =>
        resolveAutocompleteCompletion(
            query.value,
            candidates.value,
            highlightedIndex.value,
            (skill) => skill.name,
            atTextEnd.value
        )
    );
    const isOpen = computed(
        () =>
            activeTrigger.value !== null &&
            !error.value &&
            (candidates.value.length > 0 || hasCompletedQuery.value)
    );
    const completionText = computed(() => {
        if (!activeTrigger.value || (isLoading.value && !isRevalidating.value) || error.value)
            return '';
        return completion.value?.text ?? '';
    });

    async function loadCatalog(): Promise<SkillMetadata[]> {
        catalogRequest ??= loadSkills();
        return catalogRequest;
    }

    function restoreHighlight(previousSkill: SkillMetadata | null) {
        const previousIndex = previousSkill
            ? candidates.value.findIndex(
                  (skill) =>
                      normalizeSkillPath(skill.path) === normalizeSkillPath(previousSkill.path)
              )
            : -1;
        highlightedIndex.value =
            previousIndex >= 0
                ? previousIndex
                : options.autoSelectFirst?.() && candidates.value.length
                  ? 0
                  : -1;
    }

    function close() {
        session.cancel();
        refreshId += 1;
        isLoading.value = false;
        isRevalidating.value = false;
        hasCompletedQuery.value = false;
        query.value = '';
        activeTrigger.value = null;
        candidates.value = [];
        highlightedIndex.value = -1;
        error.value = false;
        catalogRequest = null;
        catalog = null;
    }

    async function refresh(
        textBeforeCursor: string,
        { resume = false, textAfterCursor = '' } = {}
    ) {
        const trigger = resolveSkillTrigger(textBeforeCursor, textAfterCursor);
        if (!trigger) {
            close();
            return;
        }

        const retainResults = resume && activeTrigger.value?.token === trigger.token;
        const previousSkill = retainResults ? highlightedSkill.value : null;
        if (resume && !isLoading.value) catalogRequest = null;
        const currentRefreshId = ++refreshId;
        activeTrigger.value = trigger;
        atTextEnd.value = textAfterCursor.length === 0;
        query.value = trigger.query;
        isRevalidating.value = retainResults;
        isLoading.value = true;
        if (!retainResults) {
            highlightedIndex.value = -1;
        }
        error.value = false;
        // Filter the known catalog in the same update as the query. A refresh may
        // keep matching rows visible, but must never show another keyword's rows.
        if (catalog) {
            candidates.value = filterSkillCandidates(
                catalog,
                trigger.query,
                options.getSelectedSkills()
            );
            restoreHighlight(previousSkill);
        }

        try {
            const snapshot = await session.search({
                query: trigger.query,
                intent: 'skill-reference',
                limit: 2000,
            });
            if (currentRefreshId !== refreshId || snapshot.stale) {
                return;
            }
            const failure = snapshot.providers.find((provider) => provider.error)?.error;
            if (failure) throw failure;
            while (
                currentRefreshId === refreshId &&
                session.snapshot.providers.some((provider) => provider.nextCursor)
            ) {
                await session.loadMore();
            }
            const loadedCatalog = await loadCatalog();
            if (currentRefreshId !== refreshId) return;
            catalog = loadedCatalog;
            candidates.value = session.snapshot.items.flatMap((match) => {
                const skill = skillSearchItem(match.result);
                return skill ? [skill] : [];
            });
            hasCompletedQuery.value = true;
            restoreHighlight(previousSkill);
        } catch {
            if (currentRefreshId === refreshId) {
                candidates.value = [];
                error.value = true;
                catalogRequest = null;
            }
        } finally {
            if (currentRefreshId === refreshId) {
                isLoading.value = false;
                isRevalidating.value = false;
            }
        }
    }

    function moveHighlight(direction: 1 | -1) {
        const count = candidates.value.length;
        if (!count) {
            highlightedIndex.value = -1;
            return;
        }

        highlightedIndex.value =
            nextResultIndex(
                highlightedIndex.value,
                count,
                direction === 1 ? 'down' : 'up',
                1,
                !options.autoSelectFirst?.()
            ) ?? highlightedIndex.value;
    }

    function selectSkill(skill: SkillMetadata) {
        const trigger = activeTrigger.value;
        if (!trigger || isLoading.value || error.value) {
            return;
        }
        const match = session.snapshot.items.find(
            (candidate) => candidate.result.id === normalizeSkillPath(skill.path)
        );
        if (match)
            void session.activate(match, 'completion', actions, {
                signal: new AbortController().signal,
            });
    }

    function selectHighlighted() {
        const skill = completion.value ? candidates.value[completion.value.index] : null;
        if (skill) {
            selectSkill(skill);
        }
    }

    function handleKeyDown(event: KeyboardEvent): boolean {
        if (!activeTrigger.value) return false;
        return handleAutocompleteKeyDown(event, {
            select: selectHighlighted,
            close,
            move: (direction) => {
                if (direction !== 'up' && direction !== 'down') return false;
                moveHighlight(direction === 'down' ? 1 : -1);
                return true;
            },
        });
    }

    return {
        isOpen,
        isLoading,
        error,
        query,
        activeTrigger,
        candidates,
        highlightedIndex,
        highlightedSkill,
        completionText,
        refresh,
        close,
        moveHighlight,
        selectSkill,
        selectHighlighted,
        handleKeyDown,
    };
}
