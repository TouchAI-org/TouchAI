<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import { useId } from 'vue';

    const gradientId = `cursor-loading-${useId()}`;
    const outline =
        'M33.4842 50.9088L69.5842 35.1088C74.5842 32.9088 78.1842 35.9088 76.8842 40.8088L63.9842 78.1088C61.5842 82.8088 56.5842 82.7088 55.0842 78.4088L50.4842 64.6088C50.0842 63.5088 49.3842 62.6088 48.1842 62.3088C43.5842 61.2088 36.6842 59.1088 33.9842 58.1088C30.4842 57.2088 29.4842 52.8088 33.4842 50.9088Z';
</script>

<template>
    <svg
        viewBox="29 32 50 52"
        fill="none"
        class="h-12 w-12"
        aria-hidden="true"
        focusable="false"
        data-testid="cursor-loading-indicator"
    >
        <defs>
            <linearGradient
                :id="gradientId"
                gradientUnits="userSpaceOnUse"
                x1="29"
                y1="32"
                x2="79"
                y2="84"
                spreadMethod="reflect"
            >
                <stop offset="0" stop-color="#858b94" />
                <stop offset="0.4" stop-color="#aeb3ba" />
                <stop offset="0.5" stop-color="#f3f4f6" />
                <stop offset="0.6" stop-color="#aeb3ba" />
                <stop offset="1" stop-color="#858b94" />
                <animateTransform
                    attributeName="gradientTransform"
                    type="translate"
                    from="-50 -52"
                    to="50 52"
                    dur="2.6s"
                    calcMode="spline"
                    keySplines="0.42 0 0.58 1"
                    keyTimes="0;1"
                    repeatCount="indefinite"
                />
            </linearGradient>
        </defs>
        <g stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
            <path
                :d="outline"
                :stroke="`url(#${gradientId})`"
                pathLength="1"
                class="cursor-loading-stroke"
            />
        </g>
    </svg>
</template>

<style scoped>
    .cursor-loading-stroke {
        stroke-dasharray: 1;
        animation: cursor-loading-draw 2600ms cubic-bezier(0.42, 0, 0.58, 1) infinite;
    }

    @keyframes cursor-loading-draw {
        0% {
            stroke-dashoffset: 1;
            opacity: 0.3;
        }

        45%,
        75% {
            stroke-dashoffset: 0;
            opacity: 1;
        }

        100% {
            stroke-dashoffset: -1;
            opacity: 0.3;
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .cursor-loading-stroke {
            animation: none;
            stroke: #858b94;
            stroke-dasharray: none;
        }
    }
</style>
