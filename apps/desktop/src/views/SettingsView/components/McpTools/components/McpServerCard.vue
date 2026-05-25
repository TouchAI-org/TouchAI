<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { useConfirm } from '@composables/useConfirm';
    import type { McpServerEntity } from '@database/types';
    import { computed } from 'vue';

    import { useMcpStore } from '@/stores/mcp';

    interface Props {
        server: McpServerEntity;
        selected: boolean;
        isToggling?: boolean;
    }

    interface Emits {
        (e: 'toggle-enabled', serverId: number): void;
        (e: 'delete'): void;
        (e: 'context-menu', event: MouseEvent): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const { confirm } = useConfirm();
    const mcpStore = useMcpStore();
    const status = computed(() => mcpStore.getServerStatus(props.server.id));

    const handleToggleEnabled = () => {
        emit('toggle-enabled', props.server.id);
    };

    const handleDelete = async () => {
        const confirmed = await confirm({
            title: '确认删除',
            message: `确定要删除服务器 "${props.server.name}" 吗？`,
            type: 'danger',
            confirmText: '删除',
            cancelText: '取消',
        });

        if (confirmed) {
            emit('delete');
        }
    };

    const handleContextMenu = (event: MouseEvent) => {
        event.preventDefault();
        emit('context-menu', event);
    };

    const statusColor = computed(() => {
        switch (status.value) {
            case 'connected':
                return 'bg-green-500';
            case 'connecting':
                return 'bg-yellow-500';
            case 'disconnected':
                return 'bg-gray-400';
            case 'error':
                return 'bg-red-500';
            default:
                return 'bg-gray-400';
        }
    });

    const statusText = computed(() => {
        switch (status.value) {
            case 'connected':
                return '已连接';
            case 'connecting':
                return '连接中';
            case 'disconnected':
                return '未连接';
            case 'error':
                return '错误';
            default:
                return '未知';
        }
    });

    const transportBadgeText = computed(() => {
        switch (props.server.transport_type) {
            case 'stdio':
                return 'Stdio';
            case 'sse':
                return 'SSE';
            case 'http':
                return 'HTTP';
            default:
                return '未知';
        }
    });

    const transportBadgeColor = computed(() => {
        switch (props.server.transport_type) {
            case 'stdio':
                return 'bg-sky-50 text-sky-700 ring-1 ring-sky-200/70';
            case 'sse':
                return 'bg-violet-50 text-violet-700 ring-1 ring-violet-200/70';
            case 'http':
                return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/70';
            default:
                return 'bg-neutral-100 text-neutral-700 ring-1 ring-neutral-200';
        }
    });

    defineExpose({ handleDelete });
</script>

<template>
    <button
        :class="[
            'w-full rounded-[11px] border px-3 py-2.5 text-left transition-colors',
            selected ? 'settings-item-selected' : 'settings-item-unselected',
        ]"
        @contextmenu="handleContextMenu"
    >
        <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
                <h3 class="truncate text-[13px] font-normal text-neutral-950">
                    {{ server.name }}
                </h3>
                <div class="mt-1 flex items-center gap-2">
                    <div class="flex items-center gap-1.5">
                        <div :class="['h-2 w-2 rounded-full', statusColor]" />
                        <span class="text-xs text-neutral-500">{{ statusText }}</span>
                    </div>
                    <span
                        :class="[
                            'rounded px-1.5 py-0.5 font-mono text-xs font-medium',
                            transportBadgeColor,
                        ]"
                    >
                        {{ transportBadgeText }}
                    </span>
                    <span
                        v-if="server.version"
                        class="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs font-medium text-neutral-600 ring-1 ring-neutral-200"
                    >
                        {{ server.version }}
                    </span>
                </div>
            </div>

            <div class="flex items-center gap-1">
                <button
                    :disabled="isToggling"
                    :class="[
                        'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
                        server.enabled ? 'bg-primary-700' : 'bg-neutral-200',
                        isToggling && 'cursor-not-allowed opacity-50',
                    ]"
                    title="启用/禁用"
                    @click.stop="handleToggleEnabled"
                >
                    <span
                        :class="[
                            'inline-block h-3 w-3 transform rounded-full bg-white transition-transform',
                            server.enabled ? 'translate-x-5' : 'translate-x-1',
                        ]"
                    />
                </button>
            </div>
        </div>
    </button>
</template>
