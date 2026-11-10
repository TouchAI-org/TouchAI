<template>
    <ResultPanel
        ref="panel"
        data-testid="skill-picker-panel"
        :list-id="picker.listId"
        :list-label="t('skills.title')"
        :active-item-id="
            picker.candidates.length && picker.highlightedIndex >= 0
                ? `${picker.listId}-${picker.highlightedIndex}`
                : undefined
        "
        :max-height="maxHeight"
        :floating="compact"
        :viewport-height="panelState ? undefined : viewportHeight"
        :row-height="rowHeight"
        :state="panelState"
        :shortcuts="shortcuts"
        :busy="picker.loading && picker.candidates.length > 0"
        preserve-focus
        @wheel="handleWheel"
        @content-resize="emit('contentResize')"
    >
        <ResultItem
            v-for="(skill, index) in picker.candidates"
            :id="`${picker.listId}-${index}`"
            :key="skill.path"
            role="option"
            tabindex="-1"
            :aria-selected="index === picker.highlightedIndex"
            :aria-disabled="picker.loading || undefined"
            :label="skill.name"
            :compact="compact"
            :show-icon="!compact"
            :description="getSkillSummary(skill)"
            :segments="splitNameByTokens(skill.name, matchTokens, true)"
            :highlighted="index === picker.highlightedIndex"
            @click="!picker.loading && emit('select', skill)"
        >
            <template #leading><SkillIcon :size="compact ? 'xs' : 'md'" /></template>
            <template #trailing>
                <SkillScopeBadge :skill="skill" />
            </template>
        </ResultItem>
    </ResultPanel>
</template>

<script setup lang="ts">
    import SkillIcon from '@components/SkillIcon.vue';
    import SkillScopeBadge from '@components/SkillScopeBadge.vue';
    import { computed, ref, watch } from 'vue';

    import {
        ResultItem,
        ResultPanel,
        type ResultPanelShortcut,
        type ResultPanelState,
    } from '@/components/ui/result-panel';
    import {
        RESULT_COMPACT_ROW_HEIGHT,
        RESULT_LIST_COLLAPSED_ROWS,
        RESULT_LIST_EXPANDED_ROWS,
        RESULT_LIST_ROW_HEIGHT,
        RESULT_VIEWPORT_PADDING,
    } from '@/components/ui/result-panel/layout';
    import { resultExpansionAfterNavigation } from '@/components/ui/result-panel/navigation';
    import { t } from '@/i18n';
    import type { SkillMetadata } from '@/services/AgentService/skills';
    import { buildMatchTokens, splitNameByTokens } from '@/utils/searchHighlight';
    import { collapseWhitespace } from '@/utils/text';

    import type { SkillPickerState } from './composables/useSkillAutocomplete';

    const props = defineProps<{
        picker: SkillPickerState;
        maxHeight?: number;
        compact?: boolean;
    }>();
    const emit = defineEmits<{
        select: [skill: SkillMetadata];
        contentResize: [];
    }>();
    const panel = ref<InstanceType<typeof ResultPanel>>();
    const expanded = ref(false);
    const rowHeight = computed(() =>
        props.compact ? RESULT_COMPACT_ROW_HEIGHT : RESULT_LIST_ROW_HEIGHT
    );
    const collapsedRows = RESULT_LIST_COLLAPSED_ROWS;
    const viewportHeight = computed(
        () =>
            RESULT_VIEWPORT_PADDING * 2 +
            Math.min(
                props.picker.candidates.length,
                props.compact
                    ? Infinity
                    : expanded.value
                      ? RESULT_LIST_EXPANDED_ROWS
                      : collapsedRows
            ) *
                rowHeight.value
    );

    function handleWheel(event: WheelEvent) {
        if (
            props.compact ||
            expanded.value ||
            props.picker.loading ||
            props.picker.error ||
            props.picker.candidates.length <= collapsedRows ||
            event.ctrlKey ||
            event.deltaY <= 0 ||
            Math.abs(event.deltaX) > event.deltaY
        )
            return;
        expanded.value = true;
        event.preventDefault();
    }

    watch(
        () => props.picker,
        (picker, previous) => {
            if (picker.loading) return;
            if (props.compact || picker.candidates.length <= collapsedRows) {
                expanded.value = false;
            } else if (!previous || (!previous.loading && picker.query === previous.query)) {
                const currentIndex = previous?.highlightedIndex ?? -1;
                expanded.value = resultExpansionAfterNavigation({
                    expanded: expanded.value,
                    currentIndex,
                    nextIndex: picker.highlightedIndex,
                    direction: picker.highlightedIndex < currentIndex ? 'up' : 'down',
                    collapsedRows,
                });
            }
        },
        { immediate: true }
    );
    const matchTokens = computed(() => buildMatchTokens(props.picker.query));
    const shortcuts = computed<ResultPanelShortcut[]>(() => {
        if (!props.picker.candidates.length) return [];
        const hints: ResultPanelShortcut[] = [
            { keys: ['↑', '↓'], label: t('search.results.navigate') },
        ];
        if (
            props.picker.candidates[props.picker.highlightedIndex] &&
            !props.picker.loading &&
            !props.picker.error
        ) {
            hints.push({
                keys: ['Enter', 'Tab'],
                separator: '/',
                label: t('search.results.insert'),
            });
        }
        hints.push({ keys: ['Esc'], label: t('search.results.close') });
        return hints;
    });
    const panelState = computed<ResultPanelState | null>(() => {
        if (props.picker.loading && !props.picker.candidates.length)
            return { kind: 'loading', message: t('skills.loading') };
        if (props.picker.error) return { kind: 'error', message: t('skills.loadFailed') };
        return props.picker.candidates.length
            ? null
            : { kind: 'empty', message: t('skills.noMatches') };
    });

    function getSkillSummary(skill: SkillMetadata) {
        return collapseWhitespace(skill.shortDescription || skill.description);
    }

    defineExpose({ getContentHeight: () => panel.value?.getContentHeight() ?? 0 });
</script>
