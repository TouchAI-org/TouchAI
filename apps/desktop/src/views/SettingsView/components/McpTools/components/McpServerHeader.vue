<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { useMcpConnection } from '@composables/useMcpConnection';
    import type { McpServerEntity } from '@database/types';
    import { computed, onUnmounted, toRef } from 'vue';

    import { useMcpStore } from '@/stores/mcp';


    import { t } from '@/i18n';
    interface Props {
        server: McpServerEntity;
        isNewServer: boolean;
    }

    interface Emits {
        (e: 'showAlert', message: string, type: 'error' | 'success'): void;
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
                return t('settings.mcp.status.connected');
            case 'connecting':
                return t('settings.mcp.status.connecting');
            case 'error':
                return t('settings.mcp.status.connectionError');
            default:
                return t('settings.mcp.status.disconnected');
        }
    });

    const serverError = computed(
        () => mcpStore.getServerError(props.server.id) || props.server.last_error
    );

    const onConnect = async () => {
        const result = await handleConnect();
        if (result.success) {
            emit(
                'showAlert',
                t('settings.mcp.messages.serverConnectSuccess', {
                    serverName: props.server.name,
                }),
                'success'
            );
        } else if (result.error) {
            emit('showAlert', t('settings.mcp.messages.connectError', { error: result.error }), 'error');
        }
    };

    const onDisconnect = async () => {
        const result = await handleDisconnect();
        if (result.success) {
            emit(
                'showAlert',
                t('settings.mcp.messages.serverDisconnectSuccess', {
                    serverName: props.server.name,
                }),
                'success'
            );
        } else if (result.error) {
            emit('showAlert', t('settings.mcp.messages.disconnectError', { error: result.error }), 'error');
        }
    };

    const onReconnect = async () => {
        const result = await handleReconnect();
        if (result.success) {
            emit(
                'showAlert',
                t('settings.mcp.messages.serverReconnectSuccess', {
                    serverName: props.server.name,
                }),
                'success'
            );
        } else if (result.error) {
            emit('showAlert', t('settings.mcp.messages.reconnectError', { error: result.error }), 'error');
        }
    };
</script>

<template>
    <div class="space-y-4">
        <div class="flex items-start justify-between gap-5">
            <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                    <h2 class="truncate text-[16px] leading-6 font-semibold text-neutral-950">
                        {{ isNewServer ? t('settings.mcp.servers.new') : server.name }}
                    </h2>
                    <span
                        v-if="!isNewServer"
                        class="rounded bg-neutral-100 px-2 py-0.5 font-mono text-xs font-normal text-neutral-600"
                    >
                        {{ server.transport_type }}
                    </span>
                    <span
                        v-if="server.version"
                        class="rounded bg-neutral-100 px-2 py-0.5 font-mono text-xs font-normal text-neutral-600"
                    >
                        {{ server.version }}
                    </span>
                </div>
            </div>
        </div>

        <!-- Status & Actions (仅现有服务器显示) -->
        <div
            v-if="!isNewServer"
            class="flex items-center justify-between gap-4 rounded-[13px] border border-neutral-200/70 bg-white px-5 py-4"
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
                <span class="text-sm font-normal text-neutral-700">
                    {{ statusText }}
                </span>
            </div>

            <div class="flex gap-2">
                <button
                    v-if="status === 'disconnected' || status === 'error'"
                    :disabled="isConnecting"
                    :class="[
                        'settings-button-primary',
                        'flex items-center gap-2',
                        isConnecting && 'cursor-not-allowed opacity-50',
                    ]"
                    @click="onConnect"
                >
                    <AppIcon
                        name="play"
                        :class="isConnecting ? 'h-4 w-4 animate-spin' : 'h-4 w-4'"
                    />
                    {{ isConnecting ? t('settings.mcp.actions.connecting') : t('settings.mcp.actions.connect') }}
                </button>
                <button
                    v-else-if="status === 'connected'"
                    :disabled="isDisconnecting"
                    :class="[
                        'settings-button-secondary',
                        'flex items-center gap-2',
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
                    {{ isDisconnecting ? t('settings.mcp.actions.disconnecting') : t('settings.mcp.actions.disconnect') }}
                </button>
                <button
                    v-if="status === 'connected'"
                    :disabled="isConnecting || isDisconnecting || isReconnecting"
                    :class="[
                        'settings-button-primary',
                        'flex items-center gap-2',
                        (isConnecting || isDisconnecting || isReconnecting) &&
                            'cursor-not-allowed opacity-50',
                    ]"
                    @click="onReconnect"
                >
                    <AppIcon
                        name="refresh"
                        :class="isReconnecting ? 'h-4 w-4 animate-spin' : 'h-4 w-4'"
                    />
                    {{ isReconnecting ? t('settings.mcp.actions.reconnecting') : t('settings.mcp.actions.reconnect') }}
                </button>
                <button
                    v-else-if="status === 'connecting'"
                    disabled
                    class="flex cursor-not-allowed items-center gap-2 rounded-lg bg-yellow-500 px-4 py-2 text-sm text-white opacity-75"
                >
                    <AppIcon name="play" class="h-4 w-4 animate-spin" />
                    {{ t('settings.mcp.actions.connecting') }}
                </button>
            </div>
        </div>

        <!-- 最近错误 -->
        <div v-if="serverError && status === 'error'" class="mt-4 rounded-lg bg-red-50 p-3">
            <div class="flex items-start gap-2">
                <AppIcon name="exclamation-triangle" class="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                <div class="settings-scrollbar max-h-[7.5rem] min-w-0 flex-1 overflow-y-auto pr-1">
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
