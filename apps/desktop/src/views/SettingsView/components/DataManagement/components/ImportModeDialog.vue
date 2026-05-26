<script setup lang="ts">
    import DialogShell from '@components/DialogShell.vue';
    import { Button } from '@components/ui/button';
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
    <DialogShell dismissible @close="emit('close')">
        <h3 class="text-[15px] font-medium text-neutral-950">选择导入模式</h3>
        <p class="mt-2 text-sm text-neutral-600">
            请选择导入方式。系统会在导入前自动备份当前数据库，导入失败会自动回滚。
        </p>

        <div class="mt-4 space-y-3">
            <Button
                variant="outline"
                class="h-auto w-full rounded-lg border border-neutral-200 px-4 py-3 text-left transition-colors hover:border-neutral-300 hover:bg-neutral-50"
                :disabled="isLoading"
                @click="emit('select', 'chat_only')"
            >
                <div>
                    <div class="text-sm font-medium text-neutral-950">仅导入对话数据</div>
                    <div class="mt-1 text-xs text-neutral-500">
                        合并会话、消息和请求记录，不覆盖当前设置
                    </div>
                </div>
            </Button>

            <Button
                variant="outline"
                class="h-auto w-full rounded-lg border border-red-200 px-4 py-3 text-left transition-colors hover:border-red-300 hover:bg-red-50"
                :disabled="isLoading"
                @click="emit('select', 'full')"
            >
                <div>
                    <div class="text-sm font-medium text-neutral-950">覆盖设置并导入对话</div>
                    <div class="mt-1 text-xs text-neutral-500">
                        覆盖设置，合并模型、服务商、会话和消息等
                    </div>
                </div>
            </Button>
        </div>

        <div class="mt-6">
            <Button
                variant="outline"
                class="w-full rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 transition-colors hover:border-neutral-300 hover:bg-neutral-50"
                :disabled="isLoading"
                @click="emit('close')"
            >
                取消
            </Button>
        </div>
    </DialogShell>
</template>
