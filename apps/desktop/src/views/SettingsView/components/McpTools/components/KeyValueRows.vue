<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'KeyValueRows',
    });

    import AppIcon from '@components/AppIcon.vue';
    import { Input } from '@components/ui/input';

    /*
     * 可增删的「键 = 值」行编辑器。
     *
     * 这段结构在 MCP 配置里出现了两次：HTTP 的 headers 与 stdio 的 env。
     * 两者的标题、占位符不同，但行布局（三分之一键 + 弹性值 + 删除按钮）、
     * 添加按钮位置、输入框样式逐字相同，共 73 行重复。
     *
     * 组件不拥有数据，只负责派发事件，与原先两个子组件的行为一致。
     */
    export interface KeyValueRow {
        key: string;
        value: string;
    }

    interface Props {
        /** 行数据 */
        rows: KeyValueRow[];
        /** 这一组行的标题（已在外部翻译） */
        title: string;
        /** 键输入框占位符 */
        keyPlaceholder: string;
        /** 值输入框占位符 */
        valuePlaceholder: string;
        /** 键输入框的 data-testid 前缀，用于 e2e 定位 */
        testIdPrefix?: string;
    }

    const props = withDefaults(defineProps<Props>(), {
        testIdPrefix: undefined,
    });

    const emit = defineEmits<{
        'update:rows': [rows: KeyValueRow[]];
        blur: [];
    }>();

    const add = () => {
        emit('update:rows', [...props.rows, { key: '', value: '' }]);
    };

    const remove = (index: number) => {
        const next = [...props.rows];
        next.splice(index, 1);
        emit('update:rows', next);
        emit('blur');
    };

    const updateKey = (index: number, key: string) => {
        const next = [...props.rows];
        const row = next[index];
        if (!row) {
            return;
        }
        next[index] = { key, value: row.value };
        emit('update:rows', next);
    };

    const updateValue = (index: number, value: string) => {
        const next = [...props.rows];
        const row = next[index];
        if (!row) {
            return;
        }
        next[index] = { key: row.key, value };
        emit('update:rows', next);
    };

    const rowTestId = (index: number) =>
        props.testIdPrefix ? `${props.testIdPrefix}-${index}` : undefined;
</script>

<template>
    <div>
        <div class="flex items-center justify-between">
            <label class="block text-sm font-medium text-neutral-700">
                {{ title }}
            </label>
            <button class="text-neutral-400 transition-colors hover:text-neutral-700" @click="add">
                <AppIcon name="plus" class="h-5 w-5" />
            </button>
        </div>
        <div v-if="rows.length > 0" class="mt-2 space-y-2">
            <div v-for="(row, index) in rows" :key="index" class="flex gap-2">
                <Input
                    variant="filled"
                    :model-value="row.key"
                    type="text"
                    class="w-1/3 px-4 py-2.5 font-mono"
                    :placeholder="keyPlaceholder"
                    :data-testid="rowTestId(index)"
                    @input="updateKey(index, ($event.target as HTMLInputElement).value)"
                    @blur="emit('blur')"
                />
                <Input
                    variant="filled"
                    :model-value="row.value"
                    type="text"
                    class="flex-1 px-4 py-2.5 font-mono"
                    :placeholder="valuePlaceholder"
                    @input="updateValue(index, ($event.target as HTMLInputElement).value)"
                    @blur="emit('blur')"
                />
                <button
                    class="text-neutral-400 transition-colors hover:text-red-600"
                    @click="remove(index)"
                >
                    <AppIcon name="x" class="h-5 w-5" />
                </button>
            </div>
        </div>
    </div>
</template>
