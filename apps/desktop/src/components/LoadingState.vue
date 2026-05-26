<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import settingsLogo from '@assets/logo.svg';

    interface Props {
        message?: string;
        fill?: 'screen' | 'full' | 'min';
        variant?: 'spinner' | 'brand';
    }

    const props = withDefaults(defineProps<Props>(), {
        fill: 'full',
        message: undefined,
        variant: 'spinner',
    });
</script>

<template>
    <div
        :class="[
            'flex items-center justify-center p-6',
            props.fill === 'screen'
                ? 'h-screen w-screen bg-[#f7f7f6]'
                : props.fill === 'min'
                  ? 'min-h-full w-full bg-white'
                  : 'h-full w-full bg-white',
        ]"
    >
        <div class="text-center">
            <img
                v-if="props.variant === 'brand'"
                :src="settingsLogo"
                alt="TouchAI"
                class="loading-state-logo mx-auto h-16 w-16 object-contain"
            />
            <div
                v-else
                class="border-primary-100 border-t-primary-500 mx-auto h-10 w-10 animate-spin rounded-full border-3"
            ></div>
            <p v-if="props.message" class="mt-4 font-serif text-sm text-gray-500">
                {{ props.message }}
            </p>
        </div>
    </div>
</template>

<style scoped>
    @keyframes loading-state-logo-breathe {
        0%,
        100% {
            opacity: 0.76;
            transform: scale(0.96);
        }

        50% {
            opacity: 1;
            transform: scale(1.03);
        }
    }

    .loading-state-logo {
        animation: loading-state-logo-breathe 2.6s ease-in-out infinite;
    }

    @media (prefers-reduced-motion: reduce) {
        .loading-state-logo {
            animation: none;
        }
    }
</style>
