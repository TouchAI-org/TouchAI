<script setup lang="ts">
    import AppUpdateRequiredGate from '@components/AppUpdateRequiredGate.vue';
    import { MotionConfig } from 'motion-v';
</script>

<template>
    <MotionConfig reduced-motion="user">
        <router-view />
        <AppUpdateRequiredGate />
    </MotionConfig>
</template>
