<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { useMcpConnection } from '@composables/useMcpConnection';
    import type { McpServerEntity } from '@database/types';
    import { computed, onUnmounted, toRef } from 'vue';

    import { useMcpStore } from '@/stores/mcp';

    interface Props {
        server: McpServerEntity;
        isNewServer: boolean;
    }

    interface Emits {
        (e: 'showAlert', message: string, type: 'success' | 'error'): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();
    const mcpStore = useMcpStore();

    // 使用 toRef 创建一个响应式引用，当 props.server.id 变化时会更新
    const serverId = toRef(() => props.server.id);
    const {
        status,
        isConnecting,
        isDisconnecting,
        isReconnecting,
        handleConnect,
        handleDisconnect,
        handleReconnect,
        cleanup: cleanupConnection,
    } = useMcpConnection(serverId);

    onUnmounted(() => {
        cleanupConnection();
    });

    const statusText = computed(() => {
        switch (status.value) {
            case 'connected':
                return '已连接';
            case 'connecting':
                return '连接中';
            case 'error':
                return '连接错误';
            default:
                return '未连接';
        }
    });

    const serverError = computed(
        () => mcpStore.getServerError(props.server.id) || props.server.last_error
    );

    const onConnect = async () => {
        const result = await handleConnect();
        if (result.success) {
            emit('showAlert', `服务器 "${props.server.name}" 连接成功`, 'success');
        } else if (result.error) {
            emit('showAlert', `连接失败: ${result.error}`, 'error');
        }
    };

    const onDisconnect = async () => {
        const result = await handleDisconnect();
        if (result.success) {
            emit('showAlert', `服务器 "${props.server.name}" 已断开`, 'success');
        } else if (result.error) {
            emit('showAlert', `断开失败: ${result.error}`, 'error');
        }
    };

    const onReconnect = async () => {
        const result = await handleReconnect();
        if (result.success) {
            emit('showAlert', `服务器 "${props.server.name}" 重新连接成功`, 'success');
        } else if (result.error) {
            emit('showAlert', `重新连接失败: ${result.error}`, 'error');
        }
    };
</script>

<template>
    <div class="rounded-lg border border-gray-200 bg-white p-6">
        <div class="flex items-center gap-6">
            <div class="text-primary-600 flex items-center justify-center">
                <AppIcon name="mcp" class="h-10 w-10" />
            </div>

            <div class="flex-1">
                <div class="flex items-center gap-3">
                    <h2 class="font-serif text-xl font-semibold text-gray-900">
                        {{ isNewServer ? '新建服务器' : server.name }}
                    </h2>
                    <span
                        v-if="!isNewServer"
                        class="rounded bg-blue-100 px-2 py-0.5 font-mono text-xs font-medium text-blue-700"
                    >
                        {{ server.transport_type }}
                    </span>
                    <span
                        v-if="server.version"
                        class="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs font-medium text-gray-600"
                    >
                        {{ server.version }}
                    </span>
                </div>
                <p class="mt-1 font-serif text-sm text-gray-600">
                    {{ isNewServer ? '填写服务器配置信息' : '配置 MCP 服务器连接参数和工具设置' }}
                </p>
            </div>
        </div>

        <!-- Status & Actions (仅现有服务器显示) -->
        <div
            v-if="!isNewServer"
            class="mt-6 flex items-center justify-between border-t border-gray-100 pt-4"
        >
            <div class="flex items-center gap-2">
                <div
                    :class="[
                        'h-3 w-3 rounded-full',
                        status === 'connected' && 'bg-green-500',
                        status === 'connecting' && 'animate-pulse bg-yellow-500',
                        status === 'disconnected' && 'bg-gray-400',
                        status === 'error' && 'bg-red-500',
                    ]"
                />
                <span class="font-serif text-sm text-gray-700">
                    {{ statusText }}
                </span>
            </div>

            <div class="flex gap-2">
                <button
                    v-if="status === 'disconnected' || status === 'error'"
                    :disabled="isConnecting"
                    :class="[
                        'bg-primary-600 hover:bg-primary-700 flex items-center gap-2 rounded-lg px-4 py-2 font-serif text-sm text-white transition-colors',
                        isConnecting && 'cursor-not-allowed opacity-50',
                    ]"
                    @click="onConnect"
                >
                    <AppIcon
                        name="play"
                        :class="isConnecting ? 'h-4 w-4 animate-spin' : 'h-4 w-4'"
                    />
                    {{ isConnecting ? '连接中...' : '连接' }}
                </button>
                <button
                    v-else-if="status === 'connected'"
                    :disabled="isDisconnecting"
                    :class="[
                        'flex items-center gap-2 rounded-lg bg-gray-100 px-4 py-2 font-serif text-sm text-gray-600 transition-colors hover:bg-gray-200',
                        isDisconnecting && 'cursor-not-allowed opacity-50',
                    ]"
                    @click="onDisconnect"
                >
                    <AppIcon
                        name="stop"
                        :class="
                            isDisconnecting
                                ? 'h-4 w-4 animate-spin text-red-600'
                                : 'h-4 w-4 text-red-600'
                        "
                    />
                    {{ isDisconnecting ? '断开中...' : '断开' }}
                </button>
                <button
                    v-if="status === 'connected'"
                    :disabled="isConnecting || isDisconnecting || isReconnecting"
                    :class="[
                        'bg-primary-600 hover:bg-primary-700 flex items-center gap-2 rounded-lg px-4 py-2 font-serif text-sm text-white transition-colors',
                        (isConnecting || isDisconnecting || isReconnecting) &&
                            'cursor-not-allowed opacity-50',
                    ]"
                    @click="onReconnect"
                >
                    <AppIcon
                        name="refresh"
                        :class="isReconnecting ? 'h-4 w-4 animate-spin' : 'h-4 w-4'"
                    />
                    {{ isReconnecting ? '重新连接中...' : '重新连接' }}
                </button>
                <button
                    v-else-if="status === 'connecting'"
                    disabled
                    class="flex cursor-not-allowed items-center gap-2 rounded-lg bg-yellow-500 px-4 py-2 font-serif text-sm text-white opacity-75"
                >
                    <AppIcon name="play" class="h-4 w-4 animate-spin" />
                    连接中...
                </button>
            </div>
        </div>

        <!-- 最近错误 -->
        <div v-if="serverError && status === 'error'" class="mt-4 rounded-lg bg-red-50 p-3">
            <div class="flex items-start gap-2">
                <AppIcon name="exclamation-triangle" class="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                <div class="custom-scrollbar max-h-[7.5rem] min-w-0 flex-1 overflow-y-auto pr-1">
                    <p
                        class="font-mono text-xs leading-5 break-all whitespace-pre-wrap text-red-600"
                    >
                        {{ serverError }}
                    </p>
                </div>
            </div>
        </div>
    </div>
</template>
