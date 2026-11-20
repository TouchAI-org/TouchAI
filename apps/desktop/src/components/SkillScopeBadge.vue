<script setup lang="ts">
    import { computed } from 'vue';

    import type { SkillMetadata } from '@/app/api/skills/catalog';
    import { Badge } from '@/components/ui/badge';
    import { t } from '@/i18n';

    const props = defineProps<{ skill: Pick<SkillMetadata, 'builtIn' | 'scope'> }>();
    const label = computed(() =>
        props.skill.builtIn
            ? 'skills.builtIn'
            : props.skill.scope === 'app'
              ? 'skills.scope.app'
              : 'skills.scope.global'
    );
</script>

<template>
    <Badge data-slot="skill-scope" variant="tag" size="sm" tone="gray">{{ t(label) }}</Badge>
</template>
