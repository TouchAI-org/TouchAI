<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div :class="rootClass" @mousedown="handleMouseDown">
        <button
            type="button"
            class="reasoning-card-toggle"
            :aria-expanded="expanded"
            @click="toggleExpanded"
        >
            <div class="reasoning-card-main">
                <AppIcon name="llm" class="reasoning-card-icon" />
                <div class="reasoning-card-text">
                    <div class="reasoning-card-title-row">
                        <span class="reasoning-card-label">
                            {{ displayLabel }}
                        </span>
                    </div>
                </div>
            </div>
            <div class="reasoning-card-meta">
                <span :class="['reasoning-card-status', statusClass]">
                    <span v-if="isReasoningActive" class="reasoning-card-pulse"></span>
                    {{ statusText }}
                </span>
                <span
                    v-if="displayDuration"
                    class="reasoning-card-duration"
                    data-no-i18n="true"
                    translate="no"
                >
                    {{ displayDuration }}
                </span>
                <AppIcon
                    name="chevron-right"
                    :class="
                        expanded
                            ? 'reasoning-card-arrow reasoning-card-arrow--expanded'
                            : 'reasoning-card-arrow'
                    "
                />
            </div>
        </button>

        <transition name="reasoning-slide">
            <div v-if="expanded" class="reasoning-card-detail">
                <MarkdownContent
                    :content="part.content"
                    :final="!isStreaming"
                    variant="reasoning"
                />
            </div>
        </transition>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import MarkdownContent from '@components/MarkdownContent.vue';
    import { computed, onUnmounted, ref, watch } from 'vue';

    import { t } from '@/i18n';
    import type { ReasoningMessagePart } from '@/types/session';

    interface Props {
        part: ReasoningMessagePart;
        isStreaming: boolean;
    }

    const props = defineProps<Props>();

    const expanded = ref(true);
    const userOverridden = ref(false);
    const now = ref(Date.now());

    let tickTimer: ReturnType<typeof setInterval> | null = null;

    function startTick() {
        if (tickTimer) return;
        now.value = Date.now();
        tickTimer = setInterval(() => {
            now.value = Date.now();
        }, 1000);
    }

    function stopTick() {
        if (tickTimer) {
            clearInterval(tickTimer);
            tickTimer = null;
        }
    }

    watch(
        () => props.isStreaming && !props.part.durationMs,
        (active) => {
            if (active) {
                startTick();
            } else {
                stopTick();
            }
        },
        { immediate: true }
    );

    onUnmounted(() => {
        stopTick();
    });

    const rootClass = 'w-full';

    const isReasoningActive = computed(() => {
        return props.isStreaming && !props.part.durationMs;
    });

    const elapsedMs = computed(() => {
        if (props.part.durationMs) {
            return props.part.durationMs;
        }

        if (props.isStreaming && props.part.startedAt) {
            void now.value;
            return Date.now() - props.part.startedAt;
        }

        return null;
    });

    const displayDuration = computed(() => formatDuration(elapsedMs.value));

    const displayLabel = computed(() => {
        const duration = displayDuration.value;
        if (duration) {
            return t('assistant.reasoningPart.duration', { duration });
        }
        return t('assistant.reasoningPart.streaming');
    });

    const statusText = computed(() => {
        if (isReasoningActive.value) {
            return t('assistant.reasoningPart.streaming');
        }
        return t('assistant.reasoningPart.completed');
    });

    const statusClass = computed(() => {
        if (isReasoningActive.value) {
            return 'reasoning-card-status--running';
        }
        return 'reasoning-card-status--completed';
    });

    function formatDuration(ms: number | null | undefined): string | null {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
            return null;
        }

        if (ms < 1000) {
            return `${Math.round(ms)}ms`;
        }

        const totalSeconds = Math.round(ms / 1000);
        if (totalSeconds < 60) {
            return `${totalSeconds}s`;
        }

        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        if (seconds === 0) {
            return `${minutes}m`;
        }

        return `${minutes}m ${seconds}s`;
    }

    function toggleExpanded() {
        userOverridden.value = true;
        expanded.value = !expanded.value;
    }

    function handleMouseDown(event: MouseEvent) {
        event.preventDefault();
    }

    watch(
        () => props.isStreaming,
        (streaming, oldStreaming) => {
            if (oldStreaming && !streaming && !userOverridden.value) {
                expanded.value = false;
            }
        }
    );
</script>

<style scoped>
    .reasoning-card-toggle {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        padding: 0.78rem 0.8rem;
        border-radius: 0.75rem;
        border: 1px solid rgba(219, 213, 207, 0.95);
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 1px 2px rgba(17, 24, 39, 0.04);
        text-align: left;
        cursor: pointer;
        transition:
            border-color 0.2s ease,
            box-shadow 0.2s ease,
            background-color 0.2s ease;
    }

    .reasoning-card-toggle:hover {
        border-color: rgba(219, 213, 207, 0.95);
        background: rgba(251, 251, 246, 0.95);
        box-shadow: 0 3px 10px rgba(107, 95, 84, 0.14);
    }

    .reasoning-card-main {
        min-width: 0;
        flex: 1 1 auto;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 12px;
    }

    .reasoning-card-icon {
        width: 1em;
        height: 1em;
        color: var(--color-primary-600);
        flex-shrink: 0;
    }

    .reasoning-card-text {
        min-width: 0;
        flex: 1 1 auto;
    }

    .reasoning-card-title-row {
        min-width: 0;
        width: 100%;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.45rem;
    }

    .reasoning-card-label {
        display: block;
        min-width: 0;
        flex: 1 1 auto;
        max-width: none;
        white-space: normal;
        overflow: visible;
        text-overflow: clip;
        word-break: break-word;
        overflow-wrap: anywhere;
        font-family: var(--font-serif), serif;
        font-size: 1em;
        line-height: 1.35;
        font-weight: 600;
        color: rgb(31, 41, 55);
        user-select: none;
    }

    .reasoning-card-meta {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        flex-shrink: 0;
    }

    .reasoning-card-status {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        font-size: 11px;
        line-height: 1.25;
        font-weight: 500;
        border: 1px solid transparent;
    }

    .reasoning-card-status--running {
        background: rgba(239, 246, 255, 0.95);
        color: var(--color-info-700);
        border-color: rgba(147, 197, 253, 0.65);
    }

    .reasoning-card-pulse {
        display: inline-block;
        width: 0.375rem;
        height: 0.375rem;
        border-radius: 999px;
        background: var(--color-info-600);
        animation: reasoning-pulse 1.3s ease-in-out infinite;
    }

    .reasoning-card-status--completed {
        background: var(--color-primary-50);
        color: var(--color-primary-600);
        border-color: rgba(219, 213, 207, 0.95);
    }

    .reasoning-card-duration {
        font-size: 11px;
        line-height: 1.25;
        color: rgb(107, 114, 128);
    }

    .reasoning-card-arrow {
        width: 0.875rem;
        height: 0.875rem;
        flex-shrink: 0;
        color: rgb(156, 163, 175);
        transition:
            transform 0.2s ease,
            color 0.2s ease;
    }

    .reasoning-card-toggle:hover .reasoning-card-arrow {
        color: rgb(107, 114, 128);
    }

    .reasoning-card-arrow--expanded {
        transform: rotate(90deg);
    }

    .reasoning-card-detail {
        margin-top: 0.45rem;
        padding: 0 0.25rem;
        font-style: italic;
        color: rgb(107, 114, 128);
        line-height: 1.8;
    }

    .reasoning-card-detail :deep(p) {
        margin-bottom: 0.75em;
    }

    .reasoning-card-detail :deep(ul),
    .reasoning-card-detail :deep(ol) {
        padding-left: 1.25em;
        margin-bottom: 0.75em;
    }

    .reasoning-card-detail :deep(li) {
        margin-bottom: 0.5em;
    }

    .reasoning-slide-enter-active,
    .reasoning-slide-leave-active {
        transition:
            opacity 0.2s ease,
            transform 0.2s ease;
    }

    .reasoning-slide-enter-from,
    .reasoning-slide-leave-to {
        opacity: 0;
        transform: translateY(-3px);
    }

    @keyframes reasoning-pulse {
        0%,
        100% {
            opacity: 0.4;
        }
        50% {
            opacity: 1;
        }
    }
</style>
