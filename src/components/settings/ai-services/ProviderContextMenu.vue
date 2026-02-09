<!-- Copyright (c) 2025. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import SvgIcon from '@components/common/SvgIcon.vue';
    import { computed, onMounted, onUnmounted, ref } from 'vue';

    interface Props {
        x: number;
        y: number;
    }

    interface Emits {
        (e: 'edit'): void;
        (e: 'delete'): void;
        (e: 'close'): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const menuRef = ref<HTMLElement | null>(null);

    const menuStyle = computed(() => ({
        left: `${props.x}px`,
        top: `${props.y}px`,
    }));

    const handleClickOutside = (event: MouseEvent) => {
        if (menuRef.value && !menuRef.value.contains(event.target as Node)) {
            emit('close');
        }
    };

    onMounted(() => {
        document.addEventListener('click', handleClickOutside);
    });

    onUnmounted(() => {
        document.removeEventListener('click', handleClickOutside);
    });

    const handleEdit = () => {
        emit('edit');
        emit('close');
    };

    const handleDelete = () => {
        emit('delete');
        emit('close');
    };
</script>

<template>
    <div
        ref="menuRef"
        class="fixed z-50 min-w-[160px] rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
        :style="menuStyle"
    >
        <button
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100"
            @click="handleEdit"
        >
            <SvgIcon name="edit" class="h-4 w-4" />
            编辑
        </button>
        <button
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50"
            @click="handleDelete"
        >
            <SvgIcon name="trash" class="h-4 w-4" />
            删除
        </button>
    </div>
</template>
