<!-- Copyright (c) 2025. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import SvgIcon from './SvgIcon.vue';

    interface Props {
        title?: string;
        message: string;
        confirmText?: string;
        cancelText?: string;
        type?: 'warning' | 'danger' | 'info';
    }

    interface Emits {
        (e: 'confirm'): void;
        (e: 'cancel'): void;
    }

    const props = withDefaults(defineProps<Props>(), {
        title: '确认操作',
        confirmText: '确定',
        cancelText: '取消',
        type: 'warning',
    });

    const emit = defineEmits<Emits>();

    const handleConfirm = () => {
        emit('confirm');
    };

    const handleCancel = () => {
        emit('cancel');
    };

    const iconName = () => {
        switch (props.type) {
            case 'danger':
                return 'exclamation-triangle';
            case 'info':
                return 'information-circle';
            default:
                return 'exclamation-triangle';
        }
    };

    const iconColorClass = () => {
        switch (props.type) {
            case 'danger':
                return 'text-red-500';
            case 'info':
                return 'text-blue-500';
            default:
                return 'text-yellow-500';
        }
    };
</script>

<template>
    <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
        @click.self="handleCancel"
    >
        <div class="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl">
            <div class="flex items-start gap-4">
                <div
                    class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full"
                    :class="{
                        'bg-red-50': type === 'danger',
                        'bg-yellow-50': type === 'warning',
                        'bg-blue-50': type === 'info',
                    }"
                >
                    <SvgIcon :name="iconName()" class="h-5 w-5" :class="iconColorClass()" />
                </div>

                <div class="flex-1">
                    <h3 class="font-serif text-base font-semibold text-gray-900">{{ title }}</h3>
                    <p class="mt-2 text-sm text-gray-600">{{ message }}</p>
                </div>
            </div>

            <div class="mt-6 flex gap-3">
                <button
                    class="flex-1 rounded-lg border border-gray-200 px-4 py-2 font-serif text-sm font-medium text-gray-600 transition-colors hover:border-gray-300 hover:bg-gray-50"
                    @click="handleCancel"
                >
                    {{ cancelText }}
                </button>
                <button
                    class="flex-1 rounded-lg px-4 py-2 font-serif text-sm font-medium text-white transition-colors"
                    :class="{
                        'bg-red-500 hover:bg-red-600': type === 'danger',
                        'bg-yellow-500 hover:bg-yellow-600': type === 'warning',
                        'bg-blue-500 hover:bg-blue-600': type === 'info',
                    }"
                    @click="handleConfirm"
                >
                    {{ confirmText }}
                </button>
            </div>
        </div>
    </div>
</template>
