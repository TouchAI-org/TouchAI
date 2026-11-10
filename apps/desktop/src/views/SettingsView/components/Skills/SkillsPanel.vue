<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import LoadingState from '@components/LoadingState.vue';
    import SkillIcon from '@components/SkillIcon.vue';
    import SkillScopeBadge from '@components/SkillScopeBadge.vue';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { Switch } from '@components/ui/switch';
    import { useConfirm } from '@composables/useConfirm';
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    import { t } from '@/i18n';
    import {
        deleteUserSkillDirectory,
        discoverManageableSkills,
        openUserSkillDirectory,
        readSkillContent,
        setUserSkillDisabled,
        type SkillMetadata,
    } from '@/services/AgentService/skills';
    import { collapseWhitespace, truncateText } from '@/utils/text';

    import { useSettingsResizablePanel } from '../../composables/useSettingsResizablePanel';

    const panel = useSettingsResizablePanel();
    const { confirm } = useConfirm();
    const skills = ref<SkillMetadata[]>([]);
    const selectedPath = ref<string | null>(null);
    const query = ref('');
    const loading = ref(true);
    const refreshing = ref(false);
    const error = ref('');
    const busyPaths = ref(new Set<string>());
    const content = ref<string | null>(null);
    const contentError = ref('');
    const contentLoading = ref(false);
    const contentViewport = ref<HTMLElement | null>(null);
    let refreshChanges: Set<string> | null = null;
    let loadVersion = 0;
    let contentVersion = 0;
    let disposed = false;

    const selected = computed(() =>
        skills.value.find((skill) => skill.path === selectedPath.value)
    );
    const filtered = computed(() => {
        const search = query.value.trim().toLocaleLowerCase();
        return skills.value.filter((skill) =>
            [skill.name, skill.description, skill.shortDescription ?? ''].some((value) =>
                value.toLocaleLowerCase().includes(search)
            )
        );
    });
    const groups = computed(() =>
        (
            [
                { scope: 'app', label: 'skills.scope.app' },
                { scope: 'shared', label: 'skills.scope.global' },
                { scope: 'builtIn', label: 'skills.builtIn' },
            ] as const
        )
            .map((group) => ({
                ...group,
                skills: filtered.value
                    .filter(
                        (skill) =>
                            (skill.builtIn ? 'builtIn' : (skill.scope ?? 'shared')) === group.scope
                    )
                    .sort((left, right) => left.name.localeCompare(right.name)),
            }))
            .filter((group) => group.skills.length > 0)
    );
    async function refresh() {
        if (refreshing.value || busyPaths.value.size) return;
        const version = ++loadVersion;
        const changedPaths = new Set<string>();
        refreshChanges = changedPaths;
        refreshing.value = true;
        error.value = '';
        try {
            const next = await discoverManageableSkills();
            if (disposed || version !== loadVersion) return;
            const current = new Map(skills.value.map((skill) => [skill.path, skill]));
            const previousPath = selectedPath.value;
            // Discovery may finish after a user has updated or deleted a skill.
            skills.value = next.flatMap((skill) => {
                if (!changedPaths.has(skill.path)) return [skill];
                const updated = current.get(skill.path);
                return updated ? [{ ...skill, disabled: updated.disabled }] : [];
            });
            if (!skills.value.some((skill) => skill.path === selectedPath.value)) {
                selectedPath.value =
                    groups.value[0]?.skills[0]?.path ?? skills.value[0]?.path ?? null;
            }
            if (selected.value && selectedPath.value === previousPath) await loadContent(true);
        } catch {
            if (!disposed && version === loadVersion) error.value = t('skills.loadFailed');
        } finally {
            if (!disposed && version === loadVersion) {
                loading.value = false;
                refreshing.value = false;
                refreshChanges = null;
            }
        }
    }

    async function loadContent(keepCurrent = false) {
        const skill = selected.value;
        const version = ++contentVersion;
        if (!keepCurrent) content.value = null;
        contentError.value = '';
        contentLoading.value = Boolean(skill);
        if (!skill) return;
        try {
            const value = await readSkillContent(skill);
            if (!disposed && version === contentVersion) content.value = value;
        } catch {
            if (!disposed && version === contentVersion)
                contentError.value = t('skills.readFailed');
        } finally {
            if (!disposed && version === contentVersion) contentLoading.value = false;
        }
    }

    function selectSkill(skill: SkillMetadata) {
        selectedPath.value = skill.path;
    }

    watch(selectedPath, () => {
        if (contentViewport.value) contentViewport.value.scrollTop = 0;
        void loadContent();
    });

    async function toggle(skill: SkillMetadata, enabled: boolean) {
        if (skill.builtIn || busyPaths.value.has(skill.path)) return;
        busyPaths.value.add(skill.path);
        refreshChanges?.add(skill.path);
        error.value = '';
        try {
            await setUserSkillDisabled(skill, !enabled);
            if (disposed) return;
            skills.value = skills.value.map((item) =>
                item.path === skill.path ? { ...item, disabled: !enabled } : item
            );
        } catch {
            if (!disposed) error.value = t('skills.updateFailed');
        } finally {
            busyPaths.value.delete(skill.path);
        }
    }

    async function openFolder(skill: SkillMetadata) {
        error.value = '';
        try {
            await openUserSkillDirectory(skill);
        } catch {
            error.value = t('skills.openFailed');
        }
    }

    async function removeSkill() {
        const skill = selected.value;
        if (!skill || skill.builtIn || busyPaths.value.has(skill.path)) return;
        busyPaths.value.add(skill.path);
        error.value = '';
        try {
            const accepted = await confirm({
                title: t('skills.deleteTitle', { name: skill.name }),
                message: t('skills.deleteMessage', { path: skill.directory }),
                confirmText: t('skills.delete'),
                cancelText: t('skills.cancel'),
                type: 'danger',
            });
            if (!accepted || disposed) return;
            refreshChanges?.add(skill.path);
            await deleteUserSkillDirectory(skill);
            if (disposed) return;
            skills.value = skills.value.filter((item) => item.path !== skill.path);
            if (selectedPath.value === skill.path)
                selectedPath.value = skills.value[0]?.path ?? null;
        } catch {
            if (!disposed) error.value = t('skills.deleteFailed');
        } finally {
            busyPaths.value.delete(skill.path);
        }
    }

    onMounted(refresh);
    onBeforeUnmount(() => {
        disposed = true;
        loadVersion++;
        contentVersion++;
        refreshChanges = null;
    });
</script>

<template>
    <div
        class="flex h-full min-h-0 bg-surface-raised text-settings-text"
        data-testid="settings-skills"
        :aria-busy="loading"
    >
        <LoadingState v-if="loading" variant="brand" fill="full" :message="t('skills.loading')" />
        <template v-else>
            <aside
                class="settings-side-panel"
                :style="panel.panelStyle.value"
                data-settings-secondary-panel="true"
            >
                <div class="flex items-center gap-2 px-4 pt-5 pb-3">
                    <div class="min-w-0 flex-1">
                        <Input
                            v-model="query"
                            variant="filled"
                            :placeholder="t('skills.search')"
                            :aria-label="t('skills.search')"
                        />
                    </div>
                    <Button
                        variant="ghost-neutral"
                        :disabled="refreshing || busyPaths.size > 0"
                        :aria-label="t('skills.refresh')"
                        :aria-busy="refreshing"
                        :title="t(refreshing ? 'skills.refreshing' : 'skills.refresh')"
                        @click="refresh"
                    >
                        <AppIcon
                            name="refresh"
                            class="h-4 w-4"
                            :class="{ 'motion-safe:animate-spin': refreshing }"
                            aria-hidden="true"
                        />
                    </Button>
                    <span
                        v-if="refreshing"
                        class="sr-only"
                        role="status"
                        :aria-label="t('skills.refreshing')"
                    >
                        {{ t('skills.refreshing') }}
                    </span>
                </div>
                <div
                    class="settings-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4"
                    data-testid="settings-skills-list"
                >
                    <p
                        v-if="skills.length && !filtered.length"
                        class="px-2 py-8 text-center text-sm"
                    >
                        {{ t('skills.noMatches') }}
                    </p>
                    <section
                        v-for="group in groups"
                        :key="group.scope"
                        :aria-label="t(group.label)"
                    >
                        <h3 class="px-3 py-3 text-xs font-medium">{{ t(group.label) }}</h3>
                        <div class="space-y-1">
                            <div
                                v-for="skill in group.skills"
                                :key="skill.path"
                                class="flex items-center gap-2.5 rounded-control border px-3 py-2.5"
                                :class="
                                    selectedPath === skill.path
                                        ? 'settings-item-selected'
                                        : 'settings-item-unselected'
                                "
                            >
                                <button
                                    type="button"
                                    class="flex min-w-0 flex-1 items-center gap-2.5 rounded-control text-left focus-visible:outline-2 focus-visible:outline-focus"
                                    :aria-pressed="selectedPath === skill.path"
                                    @click="selectSkill(skill)"
                                >
                                    <span class="min-w-0 flex-1" data-no-i18n="true" translate="no">
                                        <span class="block truncate text-compact">
                                            {{ skill.name }}
                                        </span>
                                        <span
                                            class="mt-1 block truncate text-xs leading-5 text-muted-foreground"
                                        >
                                            {{
                                                truncateText(
                                                    collapseWhitespace(
                                                        skill.shortDescription || skill.description
                                                    ),
                                                    120
                                                )
                                            }}
                                        </span>
                                    </span>
                                </button>
                                <Switch
                                    v-if="!skill.builtIn"
                                    size="md"
                                    :model-value="!skill.disabled"
                                    :disabled="busyPaths.has(skill.path)"
                                    :aria-busy="busyPaths.has(skill.path)"
                                    :data-testid="
                                        selectedPath === skill.path
                                            ? 'settings-skills-toggle-disabled'
                                            : undefined
                                    "
                                    :aria-label="
                                        t(skill.disabled ? 'skills.enable' : 'skills.disable', {
                                            name: skill.name,
                                        })
                                    "
                                    @update:model-value="toggle(skill, $event)"
                                />
                            </div>
                        </div>
                    </section>
                </div>
                <div
                    class="settings-side-panel-resizer"
                    role="separator"
                    aria-orientation="vertical"
                    :aria-label="t('skills.title')"
                    :aria-valuemin="panel.panelMinWidth"
                    :aria-valuemax="panel.panelMaxWidth.value"
                    :aria-valuenow="panel.panelWidth.value"
                    tabindex="0"
                    @keydown="panel.handleResizeKeyDown"
                    @pointerdown="panel.handleResizePointerDown"
                />
            </aside>
            <main class="flex min-w-0 flex-1 flex-col overflow-hidden bg-settings-surface">
                <div
                    v-if="error"
                    class="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-3 text-sm text-text-danger"
                    role="alert"
                >
                    <span>{{ error }}</span>
                    <Button v-if="!skills.length" variant="ghost" @click="refresh">
                        {{ t('skills.retry') }}
                    </Button>
                </div>
                <section
                    v-if="selected"
                    class="flex min-h-0 flex-1 flex-col overflow-hidden"
                    data-testid="settings-skills-detail"
                >
                    <header class="shrink-0 px-6 py-6">
                        <div class="flex items-start justify-between gap-4">
                            <div class="flex min-w-0 flex-1 items-center gap-3">
                                <SkillIcon size="lg" />
                                <h2
                                    class="min-w-0 font-serif text-lg font-semibold break-words"
                                    data-no-i18n="true"
                                    translate="no"
                                >
                                    {{ selected.name }}
                                </h2>
                                <SkillScopeBadge :skill="selected" />
                            </div>
                            <div v-if="!selected.builtIn" class="flex shrink-0 items-center gap-1">
                                <Button
                                    variant="ghost-neutral"
                                    data-testid="settings-skills-open-directory"
                                    :aria-label="t('skills.openDirectory')"
                                    :title="t('skills.openDirectory')"
                                    @click="openFolder(selected)"
                                >
                                    <AppIcon
                                        name="folder-open"
                                        class="h-4 w-4"
                                        aria-hidden="true"
                                    />
                                </Button>
                                <Button
                                    variant="ghost-neutral"
                                    :disabled="busyPaths.has(selected.path)"
                                    :aria-busy="busyPaths.has(selected.path)"
                                    data-testid="settings-skills-delete"
                                    :aria-label="t('skills.delete')"
                                    :title="t('skills.delete')"
                                    @click="removeSkill"
                                >
                                    <AppIcon name="delete" class="h-4 w-4" aria-hidden="true" />
                                </Button>
                            </div>
                        </div>
                    </header>
                    <div
                        ref="contentViewport"
                        class="settings-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto border-t border-border-subtle px-6 pt-6 pb-7"
                        data-testid="settings-skills-content"
                        :aria-busy="contentLoading"
                    >
                        <LoadingState
                            v-if="contentLoading && content === null"
                            variant="brand"
                            fill="min"
                            :message="t('skills.contentLoading')"
                        />
                        <div v-if="contentError" class="space-y-3" role="alert">
                            <p class="text-sm text-text-danger">{{ contentError }}</p>
                            <Button variant="outline-neutral" @click="loadContent(true)">
                                {{ t('skills.retry') }}
                            </Button>
                        </div>
                        <pre
                            v-if="content !== null"
                            class="font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground select-text"
                            data-no-i18n="true"
                            translate="no"
                            >{{ content }}</pre
                        >
                    </div>
                </section>
                <div
                    v-else
                    class="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
                >
                    <SkillIcon size="lg" />
                    <h2 class="font-serif text-lg">{{ t('skills.empty') }}</h2>
                    <p class="max-w-sm text-sm">{{ t('skills.emptyHint') }}</p>
                </div>
            </main>
        </template>
    </div>
</template>
