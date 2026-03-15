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
                return 'bg-blue-100 text-blue-700';
            case 'sse':
                return 'bg-purple-100 text-purple-700';
            case 'http':
                return 'bg-green-100 text-green-700';
            default:
                return 'bg-gray-100 text-gray-700';
        }
    });

    defineExpose({ handleDelete });
</script>

<template>
    <button
        :class="[
            'w-full rounded-lg border p-3 text-left transition-all',
            selected
                ? 'border-primary-600 bg-primary-50'
                : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50',
        ]"
        @contextmenu="handleContextMenu"
    >
        <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
                <h3 class="truncate font-serif text-sm font-medium text-gray-900">
                    {{ server.name }}
                </h3>
                <div class="mt-1 flex items-center gap-2">
                    <div class="flex items-center gap-1.5">
                        <div :class="['h-2 w-2 rounded-full', statusColor]" />
                        <span class="font-serif text-xs text-gray-500">{{ statusText }}</span>
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
                        class="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs font-medium text-gray-600"
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
                        server.enabled ? 'bg-primary-600' : 'bg-gray-200',
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
