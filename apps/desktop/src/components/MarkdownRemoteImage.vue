<script setup lang="ts">
    import { ImageNode, type ImageNodeProps } from 'markstream-vue';
    import { computed, ref } from 'vue';

    import { Button } from '@/components/ui/button';
    import { t } from '@/i18n';

    const props = defineProps<ImageNodeProps>();
    const approvedSource = ref('');
    // This boundary also covers reopened history whose review annotations are gone.
    const localSource = computed(() =>
        /^(?:data:image\/(?:png|jpeg|gif|webp);|blob:|asset:)/i.test(props.node.src)
    );
</script>

<template>
    <ImageNode v-if="localSource || approvedSource === node.src" v-bind="props" />
    <Button v-else variant="outline-neutral" :title="node.src" @click="approvedSource = node.src">
        {{ t('conversation.image.loadRemote') }}
        <span v-if="node.alt">({{ node.alt }})</span>
    </Button>
</template>
