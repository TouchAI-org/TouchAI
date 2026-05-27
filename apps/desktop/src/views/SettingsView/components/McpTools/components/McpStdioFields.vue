<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';

    import { t } from '@/i18n';
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

    const addEnv = () => {
        emit('update:env', [...props.env, { key: '', value: '' }]);
    };

    const removeEnv = (index: number) => {
        const newEnv = [...props.env];
        newEnv.splice(index, 1);
        emit('update:env', newEnv);
        emit('blur');
    };

    const updateEnvKey = (index: number, key: string) => {
        const newEnv = [...props.env];
        newEnv[index] = { ...newEnv[index]!, key, value: newEnv[index]!.value };
        emit('update:env', newEnv);
    };

    const updateEnvValue = (index: number, value: string) => {
        const newEnv = [...props.env];
        newEnv[index] = { ...newEnv[index]!, key: newEnv[index]!.key, value };
        emit('update:env', newEnv);
    };
</script>

<template>
    <div class="space-y-4">
        <div>
            <label class="block text-sm font-medium text-neutral-700">
                {{ t('settings.mcp.config.command') }}
                <span class="text-red-500">*</span>
            </label>
            <input
                :value="command"
                type="text"
                class="settings-input mt-1.5 w-full font-mono"
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
                    <input
                        :value="arg"
                        type="text"
                        class="settings-input flex-1 px-4 py-2.5 font-mono"
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
            <input
                :value="cwd"
                type="text"
                class="settings-input mt-1.5 w-full font-mono"
                :placeholder="t('settings.mcp.config.cwdPlaceholder')"
                @input="emit('update:cwd', ($event.target as HTMLInputElement).value)"
                @blur="emit('blur')"
            />
        </div>

        <div>
            <div class="flex items-center justify-between">
                <label class="block text-sm font-medium text-neutral-700">
                    {{ t('settings.mcp.config.env') }}
                </label>
                <button
                    class="text-neutral-400 transition-colors hover:text-neutral-700"
                    @click="addEnv"
                >
                    <AppIcon name="plus" class="h-5 w-5" />
                </button>
            </div>
            <div v-if="env.length > 0" class="mt-2 space-y-2">
                <div v-for="(envItem, index) in env" :key="index" class="flex gap-2">
                    <input
                        :value="envItem.key"
                        type="text"
                        class="settings-input w-1/3 px-4 py-2.5 font-mono"
                        :placeholder="t('settings.mcp.config.envKeyPlaceholder')"
                        @input="updateEnvKey(index, ($event.target as HTMLInputElement).value)"
                        @blur="emit('blur')"
                    />
                    <input
                        :value="envItem.value"
                        type="text"
                        class="settings-input flex-1 px-4 py-2.5 font-mono"
                        :placeholder="t('settings.mcp.config.envValuePlaceholder')"
                        @input="updateEnvValue(index, ($event.target as HTMLInputElement).value)"
                        @blur="emit('blur')"
                    />
                    <button
                        class="text-neutral-400 transition-colors hover:text-red-600"
                        @click="removeEnv(index)"
                    >
                        <AppIcon name="x" class="h-5 w-5" />
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
