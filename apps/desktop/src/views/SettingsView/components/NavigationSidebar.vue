<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { log } from '@services/ObservabilityService';
    import { openUrl } from '@tauri-apps/plugin-opener';
    import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    import { APP_PRODUCT_CONFIG, APP_VERSION } from '@/config/product';
    import { t } from '@/i18n';

    import { flattenSettingsNavigation, type NavigationSection } from '../settingsNavigation';
    import type { SettingsSearchResult } from '../settingsSearch';
    import {
        calculateSettingsSidebarWidth,
        clampSettingsSidebarWidth,
        getSettingsSidebarMaxWidth,
        SETTINGS_PRIMARY_SIDEBAR_RESIZE_EVENT,
        SETTINGS_RESIZE_KEYBOARD_STEP,
        SETTINGS_SECONDARY_PANEL_RESIZE_EVENT,
        SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH,
        SETTINGS_SIDEBAR_COLLAPSED_WIDTH,
        SETTINGS_SIDEBAR_DEFAULT_WIDTH,
        SETTINGS_SIDEBAR_MIN_WIDTH,
    } from '../settingsSidebarLayout';
    import SettingsSearch from './SettingsSearch.vue';

    export type { NavigationSection } from '../settingsNavigation';

    interface Props {
        activeSection: NavigationSection;
    }

    export type ShowUpdateSettingsOptions = {
        checkAndOpen?: boolean;
    };

    interface Emits {
        (e: 'navigate', section: NavigationSection): void;
        (e: 'ready'): void;
        (e: 'show-update-settings', options?: ShowUpdateSettingsOptions): void;
        (e: 'search-select', result: SettingsSearchResult): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const searchQuery = ref('');
    const expandedSidebarWidth = ref(SETTINGS_SIDEBAR_DEFAULT_WIDTH);
    const windowWidth = ref(window.innerWidth);
    const layoutRevision = ref(0);
    const dragStartClientX = ref(0);
    const dragStartWidth = ref(SETTINGS_SIDEBAR_DEFAULT_WIDTH);
    const activePointerId = ref<number | null>(null);
    const activeResizeTarget = ref<HTMLElement | null>(null);
    const previousBodyCursor = ref('');
    const previousBodyUserSelect = ref('');
    const isResizing = ref(false);
    const hasDraggedResizeHandle = ref(false);
    const isCollapsed = ref(false);
    const isTargetCollapsed = ref(false);
    const isLabelVisible = ref(true);
    const RESIZE_CLICK_THRESHOLD_PX = 4;
    const LABEL_FADE_BEFORE_COLLAPSE_MS = 150;
    const LABEL_FADE_AFTER_EXPAND_MS = 180;
    let sidebarAnimationTimer: ReturnType<typeof setTimeout> | null = null;

    const activeSection = computed(() => props.activeSection);
    const repositoryLinks = APP_PRODUCT_CONFIG.repository;
    const usesSecondaryPanel = computed(() =>
        ['ai-services', 'built-in-tools', 'mcp-tools'].includes(activeSection.value)
    );

    const readElementWidth = (selector: string): number | undefined => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) {
            return undefined;
        }

        const rectWidth = element.getBoundingClientRect().width;
        if (Number.isFinite(rectWidth) && rectWidth > 0) {
            return rectWidth;
        }

        const inlineWidth = Number.parseFloat(element.style.width);
        return Number.isFinite(inlineWidth) && inlineWidth > 0 ? inlineWidth : undefined;
    };

    const readSecondaryPanelWidth = (): number | undefined =>
        readElementWidth('[data-settings-secondary-panel="true"]');

    const getSidebarClampOptions = () => ({
        availableWidth: windowWidth.value,
        secondaryPanelWidth: usesSecondaryPanel.value
            ? (readSecondaryPanelWidth() ?? SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH)
            : undefined,
    });

    const sidebarMaxWidth = computed(() => {
        if (isCollapsed.value) {
            return SETTINGS_SIDEBAR_COLLAPSED_WIDTH;
        }

        const revision = layoutRevision.value;
        if (revision < 0) {
            return SETTINGS_SIDEBAR_MIN_WIDTH;
        }

        return getSettingsSidebarMaxWidth(getSidebarClampOptions());
    });

    const sidebarWidth = computed(() =>
        isCollapsed.value ? SETTINGS_SIDEBAR_COLLAPSED_WIDTH : expandedSidebarWidth.value
    );

    const sidebarStyle = computed(() => ({
        width: `${sidebarWidth.value}px`,
        minWidth: `${isCollapsed.value ? SETTINGS_SIDEBAR_COLLAPSED_WIDTH : SETTINGS_SIDEBAR_MIN_WIDTH}px`,
        maxWidth: `${sidebarMaxWidth.value}px`,
    }));

    const readPointerId = (event: Event): number | null => {
        const pointerId = (event as { pointerId?: unknown }).pointerId;

        return typeof pointerId === 'number' ? pointerId : null;
    };

    const notifyPrimarySidebarResize = () => {
        window.dispatchEvent(new CustomEvent(SETTINGS_PRIMARY_SIDEBAR_RESIZE_EVENT));
    };

    const applySidebarWidth = (width: number) => {
        const nextWidth = clampSettingsSidebarWidth(width, getSidebarClampOptions());
        if (nextWidth === expandedSidebarWidth.value) {
            return;
        }

        expandedSidebarWidth.value = nextWidth;
        notifyPrimarySidebarResize();
    };

    const clearSidebarAnimationTimer = () => {
        if (!sidebarAnimationTimer) {
            return;
        }

        clearTimeout(sidebarAnimationTimer);
        sidebarAnimationTimer = null;
    };

    const reconcileSidebarWidth = () => {
        layoutRevision.value += 1;
        if (!isCollapsed.value) {
            applySidebarWidth(expandedSidebarWidth.value);
        }
    };

    const handleLayoutResize = () => {
        windowWidth.value = window.innerWidth;
        reconcileSidebarWidth();
    };

    const expandSidebar = () => {
        clearSidebarAnimationTimer();
        isTargetCollapsed.value = false;
        isCollapsed.value = false;
        notifyPrimarySidebarResize();

        sidebarAnimationTimer = setTimeout(() => {
            isLabelVisible.value = true;
            sidebarAnimationTimer = null;
        }, LABEL_FADE_AFTER_EXPAND_MS);
    };

    const collapseSidebar = () => {
        clearSidebarAnimationTimer();
        isTargetCollapsed.value = true;
        isLabelVisible.value = false;

        sidebarAnimationTimer = setTimeout(() => {
            isCollapsed.value = true;
            notifyPrimarySidebarResize();
            sidebarAnimationTimer = null;
        }, LABEL_FADE_BEFORE_COLLAPSE_MS);
    };

    const toggleCollapsed = () => {
        if (isTargetCollapsed.value) {
            expandSidebar();
            return;
        }

        collapseSidebar();
    };

    const handleNavigate = (section: NavigationSection) => {
        emit('navigate', section);
    };

    const showUpdateSettings = () => {
        emit('show-update-settings', { checkAndOpen: true });
    };

    const openExternalLink = async (url: string) => {
        try {
            await openUrl(url);
        } catch (error) {
            log.warn('[SettingsSidebar] Failed to open external link:', url, error);
        }
    };

    const stopResize = () => {
        window.removeEventListener('pointermove', handleResizePointerMove);
        window.removeEventListener('pointerup', handleResizePointerUp);
        window.removeEventListener('pointercancel', handleResizePointerUp);
        window.removeEventListener('blur', handleResizePointerUp);

        const target = activeResizeTarget.value;
        target?.removeEventListener('pointerup', handleResizePointerUp);
        target?.removeEventListener('pointercancel', handleResizePointerUp);
        target?.removeEventListener('lostpointercapture', handleResizePointerUp);

        if (target && activePointerId.value !== null) {
            try {
                target.releasePointerCapture(activePointerId.value);
            } catch {
                // Pointer capture may already be released by the browser.
            }
        }

        if (isResizing.value) {
            document.body.style.cursor = previousBodyCursor.value;
            document.body.style.userSelect = previousBodyUserSelect.value;
        }

        activePointerId.value = null;
        activeResizeTarget.value = null;
        isResizing.value = false;
        hasDraggedResizeHandle.value = false;
    };

    const handleResizePointerMove = (event: PointerEvent) => {
        if (activePointerId.value !== null && event.pointerId !== activePointerId.value) {
            return;
        }

        const dragDelta = event.clientX - dragStartClientX.value;
        if (!hasDraggedResizeHandle.value) {
            if (Math.abs(dragDelta) <= RESIZE_CLICK_THRESHOLD_PX) {
                return;
            }

            hasDraggedResizeHandle.value = true;
            if (isTargetCollapsed.value || isCollapsed.value) {
                expandSidebar();
                dragStartClientX.value = event.clientX;
                dragStartWidth.value = Math.max(
                    expandedSidebarWidth.value,
                    SETTINGS_SIDEBAR_MIN_WIDTH
                );
                return;
            }
        }

        applySidebarWidth(
            calculateSettingsSidebarWidth(
                dragStartWidth.value,
                dragStartClientX.value,
                event.clientX,
                getSidebarClampOptions()
            )
        );
    };

    const handleResizePointerUp = (event?: Event) => {
        const pointerId = event ? readPointerId(event) : null;
        if (
            activePointerId.value !== null &&
            pointerId !== null &&
            pointerId !== activePointerId.value
        ) {
            return;
        }

        const shouldToggleCollapsed = isResizing.value && !hasDraggedResizeHandle.value;
        stopResize();
        if (shouldToggleCollapsed) {
            toggleCollapsed();
        }
    };

    const handleResizeKeyDown = (event: KeyboardEvent) => {
        let nextWidth: number | null = null;

        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleCollapsed();
            return;
        }

        if (event.key === 'ArrowLeft') {
            nextWidth = expandedSidebarWidth.value - SETTINGS_RESIZE_KEYBOARD_STEP;
        } else if (event.key === 'ArrowRight') {
            nextWidth = expandedSidebarWidth.value + SETTINGS_RESIZE_KEYBOARD_STEP;
        } else if (event.key === 'Home') {
            nextWidth = SETTINGS_SIDEBAR_MIN_WIDTH;
        } else if (event.key === 'End') {
            nextWidth = sidebarMaxWidth.value;
        }

        if (nextWidth === null) {
            return;
        }

        event.preventDefault();
        if (isTargetCollapsed.value || isCollapsed.value) {
            expandSidebar();
        }
        applySidebarWidth(nextWidth);
    };

    const handleResizePointerDown = (event: PointerEvent) => {
        if (activePointerId.value !== null) {
            event.preventDefault();
            return;
        }

        if (event.button !== 0) {
            return;
        }

        event.preventDefault();
        const resizeTarget =
            event.currentTarget instanceof HTMLElement ? event.currentTarget : null;

        dragStartClientX.value = event.clientX;
        dragStartWidth.value = expandedSidebarWidth.value;
        activePointerId.value = event.pointerId;
        activeResizeTarget.value = resizeTarget;
        previousBodyCursor.value = document.body.style.cursor;
        previousBodyUserSelect.value = document.body.style.userSelect;
        isResizing.value = true;
        hasDraggedResizeHandle.value = false;

        try {
            resizeTarget?.setPointerCapture(event.pointerId);
        } catch {
            // Pointer capture is a best-effort guard; window listeners still cover normal drags.
        }

        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', handleResizePointerMove);
        window.addEventListener('pointerup', handleResizePointerUp);
        window.addEventListener('pointercancel', handleResizePointerUp);
        window.addEventListener('blur', handleResizePointerUp);
        resizeTarget?.addEventListener('pointerup', handleResizePointerUp);
        resizeTarget?.addEventListener('pointercancel', handleResizePointerUp);
        resizeTarget?.addEventListener('lostpointercapture', handleResizePointerUp);
    };

    onBeforeUnmount(() => {
        window.removeEventListener('resize', handleLayoutResize);
        window.removeEventListener(SETTINGS_SECONDARY_PANEL_RESIZE_EVENT, handleLayoutResize);
        clearSidebarAnimationTimer();
        stopResize();
    });

    watch(activeSection, reconcileSidebarWidth, { flush: 'post' });

    onMounted(async () => {
        window.addEventListener('resize', handleLayoutResize);
        window.addEventListener(SETTINGS_SECONDARY_PANEL_RESIZE_EVENT, handleLayoutResize);
        reconcileSidebarWidth();
        await nextTick();
        emit('ready');
    });
</script>

<template>
    <div
        data-testid="settings-sidebar"
        :data-collapsed="isCollapsed"
        :data-labels-visible="isLabelVisible"
        :data-resizing="isResizing"
        :class="[
            'settings-navigation-sidebar t-sidebar relative flex h-full shrink-0 flex-col bg-canvas-sunken pt-2 pb-3.5',
            isCollapsed ? 'px-2' : 'px-3',
        ]"
        :style="sidebarStyle"
    >
        <div
            data-testid="settings-sidebar-brand"
            :class="[
                't-sidebar-brand mb-2 flex h-10 shrink-0 items-center',
                isCollapsed ? 'justify-center px-0' : 'justify-start px-3',
            ]"
            data-tauri-drag-region
        >
            <span
                :class="[
                    'settings-sidebar-label settings-sidebar-brand-label text-[18px] font-medium tracking-normal text-neutral-950',
                    isLabelVisible
                        ? 'settings-sidebar-label--visible'
                        : 'settings-sidebar-label--hidden',
                ]"
                data-tauri-drag-region
            >
                {{ t('common.settings') }}
            </span>
            <button
                v-show="!isCollapsed"
                type="button"
                data-testid="settings-sidebar-version"
                :class="[
                    't-press ml-auto inline-flex shrink-0 cursor-pointer items-center rounded-[6px] bg-surface-selected px-2 py-0.5 text-caption leading-4 text-neutral-500 transition-colors hover:bg-surface-active-strong hover:text-neutral-700',
                    isLabelVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
                ]"
                :tabindex="isLabelVisible ? undefined : -1"
                :aria-hidden="!isLabelVisible"
                @click="showUpdateSettings"
            >
                V{{ APP_VERSION }}
            </button>
        </div>

        <SettingsSearch
            v-model="searchQuery"
            :collapsed="isCollapsed"
            @expand="expandSidebar"
            @select="emit('search-select', $event)"
        />

        <nav
            v-show="!searchQuery.trim()"
            class="settings-scrollbar flex-1 space-y-1.5 overflow-y-auto pr-1"
        >
            <button
                v-for="item in flattenSettingsNavigation()"
                :key="item.id"
                type="button"
                :data-testid="`settings-nav-${item.id}`"
                :title="item.label"
                :class="[
                    't-press t-sidebar-item group flex h-10 cursor-pointer items-center rounded-control text-left text-compact font-normal',
                    isCollapsed
                        ? 'mx-auto w-10 justify-center gap-0 px-0'
                        : 'w-full justify-start gap-2.5 px-3',
                    activeSection === item.id
                        ? 'bg-surface-selected text-neutral-950'
                        : 'text-neutral-700 hover:bg-surface-hover-soft hover:text-neutral-950',
                ]"
                @click="handleNavigate(item.id)"
            >
                <AppIcon
                    :name="item.icon"
                    :class="[
                        'h-[17px] w-[17px] shrink-0 transition-colors',
                        activeSection === item.id
                            ? 'text-neutral-900'
                            : 'text-neutral-600 group-hover:text-neutral-900',
                    ]"
                />
                <span
                    :class="[
                        'settings-sidebar-label settings-sidebar-nav-label',
                        isLabelVisible
                            ? 'settings-sidebar-label--visible'
                            : 'settings-sidebar-label--hidden',
                    ]"
                >
                    {{ item.label }}
                </span>
            </button>
        </nav>

        <div
            data-testid="settings-sidebar-footer"
            :class="['t-sidebar-footer mt-3 pt-3 text-center', isCollapsed ? 'px-0' : 'px-2']"
        >
            <div class="flex items-center justify-center gap-1">
                <button
                    type="button"
                    data-testid="settings-sidebar-github"
                    :class="[
                        't-press flex cursor-pointer items-center justify-center rounded-full text-neutral-400 hover:bg-surface-hover-soft hover:text-neutral-700',
                        isCollapsed ? 'h-10 w-10' : 'h-7 w-7',
                    ]"
                    :title="t('settings.sidebar.githubRepository')"
                    @click="openExternalLink(repositoryLinks.url)"
                >
                    <AppIcon
                        name="github"
                        :class="isCollapsed ? 'h-[17px] w-[17px]' : 'h-3.5 w-3.5'"
                    />
                </button>
                <button
                    type="button"
                    data-testid="settings-sidebar-issues"
                    :class="[
                        't-press flex h-7 cursor-pointer items-center justify-center overflow-hidden rounded-full text-neutral-400 hover:bg-surface-hover-soft hover:text-neutral-700',
                        isLabelVisible ? 'w-7 opacity-100' : 'w-0 opacity-0',
                    ]"
                    :title="t('settings.sidebar.feedback')"
                    @click="openExternalLink(repositoryLinks.issuesUrl)"
                >
                    <AppIcon name="bug" class="h-3.5 w-3.5" />
                </button>
            </div>
        </div>

        <div
            data-testid="settings-sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            :aria-valuemin="
                isCollapsed ? SETTINGS_SIDEBAR_COLLAPSED_WIDTH : SETTINGS_SIDEBAR_MIN_WIDTH
            "
            :aria-valuemax="sidebarMaxWidth"
            :aria-valuenow="sidebarWidth"
            :aria-expanded="!isTargetCollapsed"
            tabindex="0"
            class="absolute top-0 right-[-3px] z-10 h-full w-1.5 cursor-col-resize transition-colors hover:bg-neutral-300/50"
            :title="t('settings.sidebar.resizeHint')"
            @keydown="handleResizeKeyDown"
            @pointerdown="handleResizePointerDown"
        />
    </div>
</template>

<style scoped>
    .settings-sidebar-label {
        display: inline-block;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        transition:
            max-width var(--duration-fast) var(--ease-smooth-out),
            opacity var(--duration-quick) var(--ease-smooth-out),
            transform var(--duration-quick) var(--ease-smooth-out);
    }

    .settings-sidebar-brand-label {
        max-width: 140px;
    }

    .settings-sidebar-nav-label {
        max-width: 150px;
    }

    .settings-sidebar-label--hidden {
        max-width: 0;
        opacity: 0;
        transform: translateX(-4px);
    }

    .settings-sidebar-label--visible {
        opacity: 1;
        transform: translateX(0);
    }
</style>
