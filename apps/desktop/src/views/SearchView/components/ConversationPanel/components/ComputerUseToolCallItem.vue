<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div class="text-sm" data-testid="computer-use-card">
        <button
            type="button"
            class="flex w-full items-center gap-2 rounded-lg border border-border-subtle bg-canvas px-2.5 py-1.5 text-left transition-colors hover:bg-surface-hover"
            :aria-expanded="expanded"
            @click="toggle"
        >
            <AppIcon name="cursor" class="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
            <span class="shrink-0 font-medium text-text-primary">{{ verbText }}</span>
            <span v-if="targetText" class="min-w-0 truncate text-xs text-text-tertiary">
                {{ targetText }}
            </span>
            <span
                class="ml-auto shrink-0 text-xs"
                :class="statusClass"
                data-testid="computer-use-status"
            >
                {{ statusText }}
            </span>
            <span v-if="durationText" class="shrink-0 text-xs text-text-tertiary">
                {{ durationText }}
            </span>
            <AppIcon
                name="chevron-right"
                class="h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform"
                :class="expanded ? 'rotate-90' : ''"
            />
        </button>

        <MotionCollapse :open="expanded" lazy>
            <div class="mt-1.5 rounded-lg border border-border-subtle bg-canvas px-2.5 py-2">
                <dl class="space-y-1 text-xs">
                    <div class="flex gap-2">
                        <dt class="w-16 shrink-0 text-text-tertiary">{{ tt('参数') }}</dt>
                        <dd class="min-w-0 break-all text-text-secondary">{{ argumentSummary }}</dd>
                    </div>
                    <div v-if="route" class="flex gap-2">
                        <dt class="w-16 shrink-0 text-text-tertiary">{{ tt('投递路径') }}</dt>
                        <dd class="min-w-0 break-all text-text-secondary">{{ route }}</dd>
                    </div>
                    <div v-if="effect" class="flex gap-2">
                        <dt class="w-16 shrink-0 text-text-tertiary">{{ tt('校验结果') }}</dt>
                        <dd
                            class="min-w-0 break-all"
                            :class="
                                effect === 'confirmed' ? 'text-text-secondary' : 'text-destructive'
                            "
                        >
                            {{ effectLabel }}
                        </dd>
                    </div>
                </dl>
                <pre
                    v-if="resultText"
                    class="mt-1.5 max-h-48 overflow-auto text-xs break-words whitespace-pre-wrap text-text-secondary"
                    >{{ resultText }}</pre
                >
            </div>
        </MotionCollapse>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import MotionCollapse from '@components/MotionCollapse.vue';
    import { computed, ref } from 'vue';

    import { t, tt } from '@/i18n';
    import type { ToolCallInfo } from '@/types/session';

    interface Props {
        durationText?: string;
        summaryText?: string;
        toolCall: ToolCallInfo;
        verbText?: string;
    }

    const props = defineProps<Props>();

    const expanded = ref(false);

    const action = computed(() => String(props.toolCall.arguments?.action ?? ''));

    const targetText = computed(() => {
        const args = props.toolCall.arguments ?? {};
        const pid = args.pid;
        const windowId = args.window_id;
        if (typeof pid === 'number' && typeof windowId === 'number') {
            return `pid ${pid} · ${windowId}`;
        }
        if (typeof pid === 'number') return `pid ${pid}`;
        if (typeof args.app === 'string') return args.app;
        return '';
    });

    const state = computed(() => {
        switch (props.toolCall.status) {
            case 'executing':
            case 'awaiting_approval':
                return 'running';
            case 'error':
                return 'error';
            case 'rejected':
            case 'cancelled':
                return 'cancelled';
            default:
                return 'done';
        }
    });

    const statusClass = computed(() => {
        if (state.value === 'running') return 'text-primary';
        if (state.value === 'error') return 'text-destructive';
        return 'text-text-tertiary';
    });

    const statusText = computed(() => {
        switch (state.value) {
            case 'running':
                return t('common.running');
            case 'error':
                return tt('失败');
            case 'cancelled':
                return t('common.cancelled');
            default:
                return t('conversation.toolCall.completed');
        }
    });

    const route = computed(() => payloadField('route'));
    const effect = computed(() => payloadField('effect'));

    const effectLabel = computed(() => {
        if (effect.value === 'confirmed') return tt('已确认');
        if (effect.value === 'unverifiable') return tt('未验证');
        return effect.value ?? '';
    });

    const structured = computed(() => {
        const payload = props.toolCall.structuredPayload;
        return payload && payload.kind === 'computer_use' ? payload : null;
    });

    /** Structured payload first, then a parsed JSON result, then nothing. */
    function payloadField(name: 'effect' | 'route'): string | null {
        if (structured.value) {
            const value = name === 'effect' ? structured.value.effect : structured.value.route;
            if (value) return value;
        }

        const result = props.toolCall.result;
        if (typeof result !== 'string') return null;
        try {
            const parsed = JSON.parse(result) as Record<string, unknown>;
            const nested = parsed['structuredContent'] as Record<string, unknown> | undefined;
            const value = parsed[name] ?? nested?.[name];
            return typeof value === 'string' ? value : null;
        } catch {
            return null;
        }
    }

    const argumentSummary = computed(() => {
        const args = { ...(props.toolCall.arguments ?? {}) };
        delete args.action;
        const entries = Object.entries(args).filter(([, value]) => value !== undefined);
        if (entries.length === 0) return action.value || '—';
        return entries.map(([key, value]) => `${key}=${String(value)}`).join(' · ');
    });

    const resultText = computed(() => {
        const result = props.toolCall.result;
        if (typeof result !== 'string') return '';
        return result.length > 1200 ? `${result.slice(0, 1200)}…` : result;
    });

    function toggle(): void {
        expanded.value = !expanded.value;
    }
</script>
