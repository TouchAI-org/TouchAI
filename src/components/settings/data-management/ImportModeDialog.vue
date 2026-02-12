<script setup lang="ts">
    import { type ImportMode } from '@database/backup';

    defineProps<{
        isLoading: boolean;
    }>();

    const emit = defineEmits<{
        (e: 'select', mode: ImportMode): void;
        (e: 'close'): void;
    }>();
</script>

<template>
    <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
        @click.self="emit('close')"
    >
        <div class="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl">
            <h3 class="font-serif text-base font-semibold text-gray-900">选择导入模式</h3>
            <p class="mt-2 text-sm text-gray-600">
                请选择导入方式。系统会在导入前自动备份当前数据库，导入失败会自动回滚。
            </p>

            <div class="mt-4 space-y-3">
                <button
                    class="w-full rounded-lg border border-gray-200 px-4 py-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50"
                    :disabled="isLoading"
                    @click="emit('select', 'chat_only')"
                >
                    <div class="font-serif text-sm font-medium text-gray-900">仅导入对话数据</div>
                    <div class="mt-1 font-serif text-xs text-gray-500">
                        合并会话、消息和请求记录，不覆盖当前设置
                    </div>
                </button>

                <button
                    class="w-full rounded-lg border border-gray-200 px-4 py-3 text-left transition-colors hover:border-red-300 hover:bg-red-50"
                    :disabled="isLoading"
                    @click="emit('select', 'full')"
                >
                    <div class="font-serif text-sm font-medium text-gray-900">
                        覆盖设置并导入对话
                    </div>
                    <div class="mt-1 font-serif text-xs text-gray-500">
                        覆盖设置，合并模型、服务商、会话和消息等
                    </div>
                </button>
            </div>

            <div class="mt-6">
                <button
                    class="w-full rounded-lg border border-gray-200 px-4 py-2 font-serif text-sm font-medium text-gray-600 transition-colors hover:border-gray-300 hover:bg-gray-50"
                    :disabled="isLoading"
                    @click="emit('close')"
                >
                    取消
                </button>
            </div>
        </div>
    </div>
</template>
