<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import EmptyState from '@components/EmptyState.vue';
    import MarkdownContent from '@components/MarkdownContent.vue';
    import { Button } from '@components/ui/button';
    import { Dialog, DialogContent, DialogTitle } from '@components/ui/dialog';
    import { computed } from 'vue';

    import { getLocale, t } from '@/i18n';
    import { formatShortDate } from '@/i18n/format';
    import type { AppUpdateReleaseSection } from '@/services/AppUpdateService/releaseNotes';

    const props = defineProps<{
        title: string;
        version: string;
        channel: string;
        publishedAt?: string | null;
        hasUpdate: boolean;
        releaseNotes: string;
        releaseSections?: AppUpdateReleaseSection[];
        actionText: string;
        busy: boolean;
        downloadProgress?: number | null;
        packageSizeBytes?: number | null;
        error?: string | null;
    }>();

    defineEmits<{
        (event: 'close'): void;
        (event: 'action'): void;
    }>();

    const isDownloading = computed(
        () => props.downloadProgress !== null && props.downloadProgress !== undefined
    );
    const releaseSections = computed(() => {
        const sections = (props.releaseSections ?? []).filter((section) => section.notes.trim());
        if (sections.length > 0) {
            return sections;
        }

        return props.releaseNotes.trim()
            ? [
                  {
                      version: props.version,
                      publishedAt: props.publishedAt ?? null,
                      notes: props.releaseNotes,
                  },
              ]
            : [];
    });
    const showVersionHeadings = computed(() => releaseSections.value.length > 1);

    function releaseHeading(section: AppUpdateReleaseSection): string {
        const date = formatShortDate(section.publishedAt);
        return date ? `V${section.version} · ${date}` : `V${section.version}`;
    }

    const versionLabel = computed(() => {
        const label = `${props.channel} V${props.version.replace(/^v/i, '')}`;
        const date = formatShortDate(props.publishedAt);
        const datedLabel = !date
            ? label
            : getLocale() === 'zh-CN'
              ? `${label}（${date}）`
              : `${label} (${date})`;
        if (
            !props.packageSizeBytes ||
            !Number.isFinite(props.packageSizeBytes) ||
            props.packageSizeBytes < 0
        )
            return datedLabel;
        const [divisor, unit] =
            props.packageSizeBytes >= 1_000_000_000
                ? ([1_000_000_000, 'gigabyte'] as const)
                : props.packageSizeBytes >= 1_000_000
                  ? ([1_000_000, 'megabyte'] as const)
                  : props.packageSizeBytes >= 1_000
                    ? ([1_000, 'kilobyte'] as const)
                    : ([1, 'byte'] as const);
        const size = new Intl.NumberFormat(getLocale(), {
            style: 'unit',
            unit,
            maximumFractionDigits: 1,
        }).format(props.packageSizeBytes / divisor);
        return `${datedLabel} · ${t('settings.general.update.packageSize', { size })}`;
    });
</script>

<template>
    <Dialog :open="true" @update:open="(open) => !open && $emit('close')">
        <DialogContent
            class="flex max-h-[calc(100dvh-64px)] w-[calc(100%-48px)] max-w-[480px] flex-col gap-0 overflow-hidden rounded-panel border border-neutral-200/80 bg-white p-0 font-serif shadow-xl"
            data-testid="settings-update-details-dialog"
            :aria-describedby="undefined"
        >
            <header class="flex shrink-0 flex-col items-center px-7 pt-8 pb-7 text-center">
                <div
                    class="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-sunken text-neutral-600"
                    aria-hidden="true"
                >
                    <AppIcon name="refresh" class="h-5 w-5" />
                </div>
                <DialogTitle class="text-[18px] leading-7 font-medium text-neutral-950">
                    {{ title }}
                </DialogTitle>
                <span
                    class="mt-3 inline-flex items-center justify-center rounded-[6px] border border-neutral-200/60 bg-surface-sunken px-2.5 py-1 text-[12px] leading-5 text-neutral-600"
                    data-testid="settings-update-dialog-version"
                >
                    {{ versionLabel }}
                </span>
            </header>

            <div class="flex min-h-0 flex-col bg-surface-raised">
                <div
                    v-if="hasUpdate || releaseSections.length > 0 || error"
                    class="settings-scrollbar max-h-112 min-h-0 overflow-y-auto overscroll-contain px-7 py-6"
                >
                    <div
                        v-if="hasUpdate || releaseSections.length > 0"
                        class="text-compact leading-6 text-neutral-700"
                    >
                        <div v-if="releaseSections.length > 0">
                            <section
                                v-for="(section, index) in releaseSections"
                                :key="section.version"
                                :class="
                                    index > 0
                                        ? 'mt-6 border-t border-neutral-200/60 pt-6'
                                        : undefined
                                "
                                data-testid="settings-update-release-section"
                            >
                                <h1
                                    v-if="showVersionHeadings"
                                    class="mb-3 text-base leading-6 font-semibold text-neutral-950"
                                >
                                    {{ releaseHeading(section) }}
                                </h1>
                                <MarkdownContent
                                    class="settings-update-release-notes"
                                    :content="section.notes"
                                    :final="true"
                                />
                            </section>
                        </div>
                        <EmptyState
                            v-else
                            :title="t('settings.general.update.dialog.noReleaseNotes')"
                            icon="document-text"
                        />
                    </div>

                    <div
                        v-if="isDownloading"
                        class="mt-4 h-1 overflow-hidden rounded-full bg-neutral-200/80"
                        role="progressbar"
                        :aria-label="t('settings.update.downloadProgress')"
                        :aria-valuenow="downloadProgress ?? undefined"
                        :aria-valuemin="0"
                        :aria-valuemax="100"
                    >
                        <div
                            class="t-progress h-full rounded-full bg-primary-600"
                            :style="{ width: `${downloadProgress}%` }"
                        />
                    </div>
                    <p v-if="error" class="mt-3 text-[12px] leading-5 text-red-600" role="alert">
                        {{ error }}
                    </p>
                </div>

                <footer
                    class="flex shrink-0 flex-wrap justify-end gap-2 border-t border-neutral-200/50 px-7 py-5"
                >
                    <Button
                        v-if="hasUpdate"
                        variant="outline-neutral"
                        class="inline-flex h-9 items-center justify-center px-4"
                        @click="$emit('close')"
                    >
                        {{
                            t(
                                isDownloading
                                    ? 'settings.general.update.dialog.action.continueInBackground'
                                    : 'common.cancel'
                            )
                        }}
                    </Button>
                    <Button
                        variant="strong"
                        class="inline-flex h-9 items-center justify-center px-4"
                        data-testid="settings-update-dialog-primary"
                        :disabled="hasUpdate && busy"
                        @click="hasUpdate ? $emit('action') : $emit('close')"
                    >
                        {{ hasUpdate ? actionText : t('common.confirm') }}
                    </Button>
                </footer>
            </div>
        </DialogContent>
    </Dialog>
</template>

<style scoped>
    .settings-update-release-notes.touchai-markdown {
        --touchai-markdown-body-size: 13px;
        --touchai-markdown-body-leading: 1.72;
        --touchai-flow-paragraph-y: 0.64rem;
        --touchai-flow-list-y: 0.58rem;
        --touchai-flow-list-item-y: 0.24rem;
        --touchai-flow-heading-1-mt: 0.7rem;
        --touchai-flow-heading-1-mb: 0.44rem;
        --touchai-flow-heading-2-mt: 0.66rem;
        --touchai-flow-heading-2-mb: 0.4rem;
        --touchai-flow-heading-3-mt: 0.6rem;
        --touchai-flow-heading-3-mb: 0.34rem;
        --touchai-heading-1-size: 1.18em;
        --touchai-heading-2-size: 1.12em;
        --touchai-heading-3-size: 1.08em;
        font-size: 13px;
        line-height: 1.72;
        letter-spacing: 0;
    }
</style>
