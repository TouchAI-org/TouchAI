<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import type { AppIconName } from '@components/appIconMap';
    import {
        DropdownMenu,
        DropdownMenuContent,
        DropdownMenuItem,
        DropdownMenuTrigger,
    } from '@components/ui/dropdown-menu';
    import { useStateMachine } from 'reka-ui';
    import { computed } from 'vue';

    export interface ContextMenuItem {
        key: string;
        label: string;
        icon?: AppIconName;
        danger?: boolean;
    }

    const props = defineProps<{
        x: number;
        y: number;
        items: ContextMenuItem[];
        menuId: string;
    }>();

    const emit = defineEmits<{
        (e: 'select', key: string): void;
        (e: 'close'): void;
        (e: 'closed'): void;
    }>();

    const { state: phase, dispatch } = useStateMachine('open', {
        open: { close: 'closing' },
        closing: { finish: 'closed' },
        closed: {},
    } as const);
    const isOpen = computed(() => phase.value === 'open');

    const menuStyle = computed(() => ({
        left: `${Math.max(0, props.x)}px`,
        top: `${Math.max(0, props.y)}px`,
    }));

    const requestClose = () => {
        if (!isOpen.value) return;
        dispatch('close');
        emit('close');
    };

    const handleOpenChange = (open: boolean) => {
        if (!open) requestClose();
    };

    const handleSelect = (key: string) => {
        if (!isOpen.value) return;
        dispatch('close');
        try {
            emit('select', key);
        } finally {
            emit('close');
        }
    };

    const handleAnimationEnd = (event: AnimationEvent) => {
        if (
            phase.value === 'closing' &&
            event.target === event.currentTarget &&
            event.animationName === 't-dropdown-out'
        ) {
            dispatch('finish');
            emit('closed');
        }
    };

    const close = requestClose;

    defineExpose({ close });
</script>

<template>
    <DropdownMenu :open="isOpen" modal @update:open="handleOpenChange">
        <DropdownMenuTrigger as-child>
            <div class="pointer-events-none fixed h-px w-px opacity-0" :style="menuStyle"></div>
        </DropdownMenuTrigger>
        <DropdownMenuContent
            :side-offset="2"
            align="start"
            class="min-w-[160px] rounded-lg border border-gray-200 bg-white py-1 font-serif shadow-lg"
            :data-context-menu-id="menuId"
            @animationend="handleAnimationEnd"
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
                <AppIcon v-if="item.icon" :name="item.icon" class="h-4 w-4" />
                {{ item.label }}
            </DropdownMenuItem>
        </DropdownMenuContent>
    </DropdownMenu>
</template>
