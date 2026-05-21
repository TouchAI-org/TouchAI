<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';

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
            <label class="block font-serif text-sm font-medium text-gray-600">
                命令
                <span class="text-red-500">*</span>
            </label>
            <input
                :value="command"
                type="text"
                class="focus:border-primary-400 mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-gray-900 transition-colors focus:outline-none"
                placeholder="例如: npx"
                @input="emit('update:command', ($event.target as HTMLInputElement).value)"
                @blur="emit('blur')"
            />
        </div>

        <div>
            <div class="flex items-center justify-between">
                <label class="block font-serif text-sm font-medium text-gray-600">参数</label>
                <button class="text-gray-400 transition-colors hover:text-gray-600" @click="addArg">
                    <AppIcon name="plus" class="h-5 w-5" />
                </button>
            </div>
            <div v-if="args.length > 0" class="mt-2 space-y-2">
                <div v-for="(arg, index) in args" :key="index" class="flex gap-2">
                    <input
                        :value="arg"
                        type="text"
                        class="focus:border-primary-400 flex-1 rounded-lg border border-gray-200 px-4 py-2.5 font-mono text-sm text-gray-900 transition-colors focus:outline-none"
                        placeholder="参数值"
                        @input="updateArg(index, ($event.target as HTMLInputElement).value)"
                        @blur="emit('blur')"
                    />
                    <button
                        class="text-gray-400 transition-colors hover:text-red-600"
                        @click="removeArg(index)"
                    >
                        <AppIcon name="x" class="h-5 w-5" />
                    </button>
                </div>
            </div>
        </div>

        <div>
            <label class="block font-serif text-sm font-medium text-gray-600">工作目录</label>
            <input
                :value="cwd"
                type="text"
                class="focus:border-primary-400 mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-gray-900 transition-colors focus:outline-none"
                placeholder="例如: /path/to/directory"
                @input="emit('update:cwd', ($event.target as HTMLInputElement).value)"
                @blur="emit('blur')"
            />
        </div>

        <div>
            <div class="flex items-center justify-between">
                <label class="block font-serif text-sm font-medium text-gray-600">环境变量</label>
                <button class="text-gray-400 transition-colors hover:text-gray-600" @click="addEnv">
                    <AppIcon name="plus" class="h-5 w-5" />
                </button>
            </div>
            <div v-if="env.length > 0" class="mt-2 space-y-2">
                <div v-for="(envItem, index) in env" :key="index" class="flex gap-2">
                    <input
                        :value="envItem.key"
                        type="text"
                        class="focus:border-primary-400 w-1/3 rounded-lg border border-gray-200 px-4 py-2.5 font-mono text-sm text-gray-900 transition-colors focus:outline-none"
                        placeholder="变量名"
                        @input="updateEnvKey(index, ($event.target as HTMLInputElement).value)"
                        @blur="emit('blur')"
                    />
                    <input
                        :value="envItem.value"
                        type="text"
                        class="focus:border-primary-400 flex-1 rounded-lg border border-gray-200 px-4 py-2.5 font-mono text-sm text-gray-900 transition-colors focus:outline-none"
                        placeholder="变量值"
                        @input="updateEnvValue(index, ($event.target as HTMLInputElement).value)"
                        @blur="emit('blur')"
                    />
                    <button
                        class="text-gray-400 transition-colors hover:text-red-600"
                        @click="removeEnv(index)"
                    >
                        <AppIcon name="x" class="h-5 w-5" />
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
