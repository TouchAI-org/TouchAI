<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import { computerUse } from '@services/NativeService';
    import type { ComputerUseFeedback } from '@services/NativeService/computerUse';
    import { log } from '@services/ObservabilityService';
    import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
    import { computed, onMounted, onUnmounted, ref } from 'vue';
    import { I18nT } from 'vue-i18n';

    import { setLocale, t } from '@/i18n';
    import IconMousePointer from '~icons/lucide/mouse-pointer-2';

    defineOptions({
        name: 'ComputerUseGlowView',
    });

    const feedback = ref<ComputerUseFeedback>({
        generation: -1,
        activities: [],
        banner: null,
        locale: 'en-US',
    });
    const pointers = computed(() =>
        feedback.value.activities.filter((activity) => activity.pointer)
    );
    const colors = [
        'var(--color-focus)',
        'var(--color-text-success)',
        'var(--color-text-warning)',
        'var(--color-text-info)',
    ];
    let unlistenPulse: (() => void) | null = null;
    let disposed = false;

    function receive(payload: ComputerUseFeedback): void {
        if (disposed || !payload || payload.generation < feedback.value.generation) return;
        feedback.value = payload;
        if (payload.locale) setLocale(payload.locale);
    }

    onMounted(async () => {
        try {
            const unlisten = await getCurrentWebviewWindow().listen<ComputerUseFeedback>(
                'computer-use-glow-pulse',
                ({ payload }) => receive(payload)
            );
            if (disposed) unlisten();
            else {
                unlistenPulse = unlisten;
                receive(await computerUse.feedback());
            }
        } catch (error) {
            log.warn('[ComputerUseGlow] Failed to listen for pulse events:', error);
        }
    });

    onUnmounted(() => {
        disposed = true;
        unlistenPulse?.();
        unlistenPulse = null;
    });
</script>

<template>
    <div data-computer-use-glow>
        <div
            v-if="feedback.activities.length > 0"
            data-computer-use-frame
            :data-active="feedback.activities.length > 0"
            aria-hidden="true"
        />
        <div
            v-if="feedback.activities.length"
            data-testid="computer-use-status"
            class="font-sans"
            role="status"
            :style="
                feedback.banner
                    ? { left: `${feedback.banner.x}px`, top: `${feedback.banner.y}px` }
                    : {}
            "
        >
            <I18nT
                keypath="computerUse.feedback.active"
                scope="global"
                tag="span"
                data-status-caption
            >
                <template #appName><strong>TouchAI</strong></template>
            </I18nT>
            <span data-stop-hint>
                {{ t('computerUse.feedback.press') }}
                <kbd>Esc</kbd>
                {{ t('computerUse.feedback.stop') }}
            </span>
        </div>
        <div
            v-for="activity in pointers"
            :key="activity.id"
            data-testid="computer-use-pointer"
            aria-hidden="true"
            :style="{
                transform: `translate(${activity.pointer!.x}px, ${activity.pointer!.y}px)`,
                '--pointer-color': colors[(activity.ordinal - 1) % colors.length],
            }"
        >
            <IconMousePointer class="h-8 w-8" />
            <span data-pointer-label>
                {{
                    feedback.activities.length > 1
                        ? t('computerUse.feedback.session', { number: activity.ordinal })
                        : 'TouchAI'
                }}
            </span>
        </div>
    </div>
</template>

<style scoped>
    :global(html),
    :global(body),
    :global(#app) {
        background: transparent !important;
        border-radius: 0 !important;
    }

    [data-computer-use-glow] {
        --glow-halo-soft: color-mix(in srgb, var(--color-focus) 24%, transparent);
        --glow-halo: color-mix(in srgb, var(--color-focus) 44%, transparent);
        --glow-halo-strong: color-mix(in srgb, var(--color-focus) 68%, transparent);

        position: fixed;
        inset: 0;
        overflow: hidden;
        pointer-events: none;
    }

    [data-computer-use-frame] {
        --glow-breath-duration: calc(var(--motion-loading-cycle) * 2);

        position: absolute;
        inset: 0;
        opacity: 1;
    }

    [data-computer-use-frame][data-active='true'] {
        animation: computer-use-breathe var(--glow-breath-duration) var(--ease-in-out) infinite;
    }

    [data-testid='computer-use-pointer'] {
        position: absolute;
        top: 0;
        left: 0;
        color: var(--color-text-inverse);
        opacity: 1;
        transition: transform var(--duration-micro) linear;
        filter: drop-shadow(0 calc(var(--spacing) / 2) var(--spacing) var(--color-border-strong));
    }

    [data-testid='computer-use-pointer'] > svg {
        transform: translate(-12.5%, -12.5%);
    }

    [data-testid='computer-use-pointer'] :deep(path) {
        fill: var(--pointer-color);
        stroke: var(--color-text-inverse);
        stroke-width: 1.5;
        stroke-linejoin: round;
    }

    [data-pointer-label] {
        position: absolute;
        top: calc(var(--spacing) * 6);
        left: calc(var(--spacing) * 6);
        padding: var(--spacing) calc(var(--spacing) * 2);
        color: var(--color-text-inverse);
        background: color-mix(in srgb, var(--pointer-color) 75%, var(--color-text-primary));
        border: 1px solid color-mix(in srgb, var(--color-text-inverse) 45%, transparent);
        border-radius: var(--radius-control);
        font-size: var(--text-xs);
        font-weight: var(--font-weight-medium);
        line-height: var(--text-xs--line-height);
        white-space: nowrap;
    }

    [data-testid='computer-use-status'] {
        --status-hairline: 1px;
        --status-edge: color-mix(in srgb, var(--color-text-inverse) 12%, transparent);
        --status-shadow: color-mix(in srgb, var(--color-text-neutral) 12%, transparent);

        position: absolute;
        top: 0;
        left: 50%;
        display: flex;
        align-items: center;
        gap: calc(var(--spacing) * 4);
        width: max-content;
        max-width: calc(100% - var(--spacing) * 8);
        margin-top: calc(var(--spacing) * 3);
        padding: calc(var(--spacing) * 1.5) calc(var(--spacing) * 3.5);
        transform: translateX(-50%);
        color: var(--color-text-inverse);
        background: color-mix(in srgb, var(--color-text-neutral) 96%, transparent);
        border-radius: var(--radius-control);
        box-shadow:
            0 0 0 var(--status-hairline) var(--status-edge),
            0 calc(var(--spacing) / 2) calc(var(--spacing) * 2) var(--status-shadow);
        font-size: var(--text-compact);
        font-weight: var(--font-weight-normal);
        line-height: var(--text-sm--line-height);
        white-space: nowrap;
    }

    [data-status-caption] {
        display: flex;
        align-items: baseline;
        gap: var(--spacing);
    }

    [data-status-caption] strong {
        font-weight: var(--font-weight-medium);
    }

    [data-stop-hint] {
        display: flex;
        align-items: center;
        gap: var(--spacing);
        font-size: var(--text-xs);
        opacity: 0.78;
        white-space: nowrap;
    }

    kbd {
        font: inherit;
    }

    [data-computer-use-frame]::after {
        position: absolute;
        inset: 0;
        content: '';
        pointer-events: none;
        box-shadow:
            inset 0 0 calc(var(--spacing) * 6) var(--spacing) var(--glow-halo-strong),
            inset 0 0 calc(var(--spacing) * 16) calc(var(--spacing) * 2) var(--glow-halo),
            inset 0 0 calc(var(--spacing) * 24) var(--glow-halo-soft);
    }

    @keyframes computer-use-breathe {
        0%,
        100% {
            opacity: 0.65;
        }
        50% {
            opacity: 1;
        }
    }

    @media (min-resolution: 2dppx) {
        [data-testid='computer-use-status'] {
            --status-hairline: 0.5px;
        }
    }

    @media (min-resolution: 3dppx) {
        [data-testid='computer-use-status'] {
            --status-hairline: calc(1px / 3);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        [data-computer-use-frame][data-active='true'],
        [data-testid='computer-use-pointer'] {
            animation: none;
            transition: none;
            opacity: 1;
        }
    }
</style>
