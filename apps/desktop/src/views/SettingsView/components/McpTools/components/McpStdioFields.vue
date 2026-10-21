<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { Input } from '@components/ui/input';

    import { t } from '@/i18n';

    import KeyValueRows from './KeyValueRows.vue';
    interface Props {
        command: string;
        args: string[];
        cwd: string;
        env: { key: string; value: string }[];
    }

    interface Emits {
        (e: 'update:command', value: string): void;
        (e: 'update:args', value: string[]): void;
        (e: 'update:cwd', value: string): void;
        (e: 'update:env', value: { key: string; value: string }[]): void;
        (e: 'blur'): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const addArg = () => {
        emit('update:args', [...props.args, '']);
    };

    const removeArg = (index: number) => {
        const newArgs = [...props.args];
        newArgs.splice(index, 1);
        emit('update:args', newArgs);
        emit('blur');
    };

    const updateArg = (index: number, value: string) => {
        const newArgs = [...props.args];
        newArgs[index] = value;
        emit('update:args', newArgs);
    };

    const updateEnv = (next: { key: string; value: string }[]) => {
        emit('update:env', next);
    };
</script>

<template>
    <div class="space-y-4">
        <div>
            <label class="block text-sm font-medium text-neutral-700">
                {{ t('settings.mcp.config.command') }}
                <span class="text-red-500">*</span>
            </label>
            <Input
                variant="filled"
                :model-value="command"
                type="text"
                class="mt-1.5 w-full font-mono"
                :placeholder="t('settings.mcp.config.commandPlaceholder')"
                @input="emit('update:command', ($event.target as HTMLInputElement).value)"
                @blur="emit('blur')"
            />
        </div>

        <div>
            <div class="flex items-center justify-between">
                <label class="block text-sm font-medium text-neutral-700">
                    {{ t('common.parameters') }}
                </label>
                <button
                    class="text-neutral-400 transition-colors hover:text-neutral-700"
                    @click="addArg"
                >
                    <AppIcon name="plus" class="h-5 w-5" />
                </button>
            </div>
            <div v-if="args.length > 0" class="mt-2 space-y-2">
                <div v-for="(arg, index) in args" :key="index" class="flex gap-2">
                    <Input
                        variant="filled"
                        :model-value="arg"
                        type="text"
                        class="flex-1 px-4 py-2.5 font-mono"
                        :placeholder="t('settings.mcp.config.argPlaceholder')"
                        @input="updateArg(index, ($event.target as HTMLInputElement).value)"
                        @blur="emit('blur')"
                    />
                    <button
                        class="text-neutral-400 transition-colors hover:text-red-600"
                        @click="removeArg(index)"
                    >
                        <AppIcon name="x" class="h-5 w-5" />
                    </button>
                </div>
            </div>
        </div>

        <div>
            <label class="block text-sm font-medium text-neutral-700">
                {{ t('settings.mcp.config.cwd') }}
            </label>
            <Input
                variant="filled"
                :model-value="cwd"
                type="text"
                class="mt-1.5 w-full font-mono"
                :placeholder="t('settings.mcp.config.cwdPlaceholder')"
                @input="emit('update:cwd', ($event.target as HTMLInputElement).value)"
                @blur="emit('blur')"
            />
        </div>

        <KeyValueRows
            :rows="props.env"
            :title="t('settings.mcp.config.env')"
            :key-placeholder="t('settings.mcp.config.envKeyPlaceholder')"
            :value-placeholder="t('settings.mcp.config.envValuePlaceholder')"
            @update:rows="updateEnv"
            @blur="emit('blur')"
        />
    </div>
</template>
