<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div class="tool-call-item rounded-lg border border-gray-200 bg-white">
        <!-- 头部：整行可点击 -->
        <button
            class="w-full p-4 text-left transition-colors hover:bg-gray-50"
            @click="toggleExpanded"
        >
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                    <span class="font-serif text-sm font-medium text-gray-900">
                        {{ toolCall.name }}
                    </span>
                    <span
                        class="bg-primary-50 text-primary-600 rounded px-1.5 py-0.5 font-mono text-xs font-medium"
                    >
                        {{ serverName }}
                    </span>
                </div>
                <div class="flex items-center gap-1.5">
                    <SvgIcon
                        v-if="toolCall.status === 'executing'"
                        name="refresh"
                        class="h-4 w-4 animate-spin text-blue-500"
                    />
                    <SvgIcon
                        v-else-if="toolCall.status === 'completed'"
                        name="check-circle"
                        class="h-4 w-4 text-green-500"
                    />
                    <SvgIcon
                        v-else-if="toolCall.status === 'error'"
                        name="x-circle"
                        class="h-4 w-4 text-red-500"
                    />
                    <span v-if="toolCall.durationMs" class="font-serif text-xs text-gray-500">
                        {{ toolCall.durationMs }}ms
                    </span>
                    <SvgIcon
                        name="chevron-right"
                        :class="
                            isExpanded
                                ? 'ml-1 h-4 w-4 rotate-90 text-gray-500 transition-transform'
                                : 'ml-1 h-4 w-4 text-gray-500 transition-transform'
                        "
                    />
                </div>
            </div>
        </button>

        <!-- 内容（可折叠） -->
        <div v-if="isExpanded" class="border-t border-gray-200 bg-gray-50 p-4">
            <ToolLogContent
                :input="JSON.stringify(toolCall.arguments)"
                :output="toolCall.result"
                :is-error="toolCall.isError"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
    import SvgIcon from '@components/common/SvgIcon.vue';
    import ToolLogContent from '@components/common/ToolLogContent.vue';
    import type { ToolCallInfo } from '@composables/useAgent.ts';
    import { computed, ref } from 'vue';

    import { useMcpStore } from '@/stores/mcp';

    interface Props {
        toolCall: ToolCallInfo;
    }

    const props = defineProps<Props>();

    const isExpanded = ref(false);
    const mcpStore = useMcpStore();

    const serverName = computed(() => mcpStore.serverNameById(props.toolCall.serverId));

    function toggleExpanded() {
        isExpanded.value = !isExpanded.value;
    }
</script>

<style scoped>
    .tool-call-item {
        font-size: 14px;
    }

    @keyframes spin {
        from {
            transform: rotate(0deg);
        }
        to {
            transform: rotate(360deg);
        }
    }

    .animate-spin {
        animation: spin 1s linear infinite;
    }
</style>
