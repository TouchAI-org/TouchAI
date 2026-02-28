<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import SvgIcon from '@components/common/SvgIcon.vue';
    import {
        DropdownMenu,
        DropdownMenuContent,
        DropdownMenuItem,
        DropdownMenuTrigger,
    } from '@components/ui/dropdown-menu';
    import { computed, ref } from 'vue';

    export interface ContextMenuItem {
        key: string;
        label: string;
        icon?: string;
        danger?: boolean;
    }

    const props = defineProps<{
        x: number;
        y: number;
        items: ContextMenuItem[];
    }>();

    const emit = defineEmits<{
        (e: 'select', key: string): void;
        (e: 'close'): void;
    }>();

    const isOpen = ref(true);

    const menuStyle = computed(() => ({
        left: `${Math.max(0, props.x)}px`,
        top: `${Math.max(0, props.y)}px`,
    }));

    const handleOpenChange = (open: boolean) => {
        isOpen.value = open;
        if (!open) {
            emit('close');
        }
    };

    const handleSelect = (key: string) => {
        emit('select', key);
        emit('close');
    };
</script>

<template>
    <DropdownMenu :open="isOpen" modal @update:open="handleOpenChange">
        <DropdownMenuTrigger as-child>
            <div class="pointer-events-none fixed h-px w-px opacity-0" :style="menuStyle"></div>
        </DropdownMenuTrigger>
        <DropdownMenuContent
            :side-offset="2"
            align="start"
            class="min-w-[160px] rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
        >
            <DropdownMenuItem
                v-for="item in items"
                :key="item.key"
                :class="[
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
                    item.danger
                        ? 'text-red-600 data-[highlighted]:bg-red-50'
                        : 'text-gray-700 data-[highlighted]:bg-gray-100',
                ]"
                @select.prevent="handleSelect(item.key)"
            >
                <SvgIcon v-if="item.icon" :name="item.icon" class="h-4 w-4" />
                {{ item.label }}
            </DropdownMenuItem>
        </DropdownMenuContent>
    </DropdownMenu>
</template>
