<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<template>
    <VisualReplyFrame
        :source="html"
        :create-srcdoc="createArtifactSrcdoc"
        :title="title || 'Interactive artifact'"
    />
</template>

<script setup lang="ts">
    import VisualReplyFrame from '@/components/VisualReplyFrame.vue';
    import { createArtifactSrcdoc } from '@/services/VisualReplyService/iframe';

    defineProps<{ html: string; title?: string }>();
</script>
