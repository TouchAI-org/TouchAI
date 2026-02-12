<script setup lang="ts">
    import SvgIcon from '@components/common/SvgIcon.vue';
    import { computed } from 'vue';

    const props = defineProps<{
        title: string;
        message: string;
        progress?: number; // 0-100
        status?: 'loading' | 'success' | 'warning' | 'error';
        dismissible?: boolean;
    }>();

    const emit = defineEmits<{
        dismiss: [];
    }>();

    const iconConfig = computed(() => {
        switch (props.status) {
            case 'success':
                return { name: 'check-circle', bg: 'bg-green-50', text: 'text-green-600' };
            case 'error':
                return { name: 'x-circle', bg: 'bg-red-50', text: 'text-red-600' };
            case 'warning':
                return {
                    name: 'exclamation-triangle',
                    bg: 'bg-yellow-50',
                    text: 'text-yellow-600',
                };
            default:
                return { name: 'refresh', bg: 'bg-primary-50', text: 'text-primary-600' };
        }
    });

    const isSpinning = computed(() => props.status === 'loading' || !props.status);
</script>

<template>
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div
            class="relative w-full max-w-sm rounded-xl border border-gray-200 bg-white p-6 shadow-xl"
        >
            <div class="flex flex-col items-center justify-center text-center">
                <button
                    v-if="props.dismissible"
                    class="absolute top-3 right-3 rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                    @click="emit('dismiss')"
                >
                    <SvgIcon name="x" class="h-4 w-4" />
                </button>
                <div
                    class="mb-4 flex h-12 w-12 items-center justify-center rounded-full"
                    :class="[iconConfig.bg, iconConfig.text]"
                >
                    <SvgIcon
                        :name="iconConfig.name"
                        :class="'h-6 w-6' + (isSpinning ? ' animate-spin' : '')"
                    />
                </div>

                <h3 class="font-serif text-lg font-semibold text-gray-900">{{ title }}</h3>
                <p class="mt-2 text-sm text-gray-600">{{ message }}</p>

                <div v-if="progress !== undefined" class="mt-6 w-full">
                    <div class="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                        <div
                            class="bg-primary-600 h-full rounded-full transition-all duration-300 ease-out"
                            :style="{ width: `${progress}%` }"
                        ></div>
                    </div>
                    <div class="mt-2 text-right text-xs font-medium text-gray-500">
                        {{ Math.round(progress) }}%
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
