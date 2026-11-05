<script setup lang="ts">
    import AppUpdateRequiredGate from '@components/AppUpdateRequiredGate.vue';
    import { MotionConfig } from 'motion-v';
    import { storeToRefs } from 'pinia';
    import { computed } from 'vue';

    import { provideMotionPreferences } from '@/composables/useMotion';
    import { useSettingsStore } from '@/stores/settings';

    const { animationSpeed, automaticallyReduceMotion, initialized } =
        storeToRefs(useSettingsStore());
    provideMotionPreferences(
        animationSpeed,
        computed(() => initialized.value && automaticallyReduceMotion.value)
    );
</script>

<template>
    <!-- motion-v caches this option on mount. Reactive useMotion transitions own reduction
         and recovery, including layout, so existing elements never need to remount. -->
    <MotionConfig reduced-motion="never">
        <router-view />
        <AppUpdateRequiredGate />
    </MotionConfig>
</template>
