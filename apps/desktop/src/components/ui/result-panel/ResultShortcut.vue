<template>
    <Primitive
        :as="as"
        :type="as === 'button' ? 'button' : undefined"
        data-slot="result-shortcut"
        class="inline-flex shrink-0 items-center gap-1.5 rounded-xs font-serif text-xs leading-5 whitespace-nowrap text-search-control select-none"
        :class="
            as === 'button'
                ? 'min-h-7 cursor-pointer outline-none hover:text-search-text focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2'
                : undefined
        "
    >
        <span v-if="keys.length" class="inline-flex items-center gap-1">
            <template v-for="(key, index) in keys" :key="key">
                <span v-if="index && separator" class="text-search-muted">{{ separator }}</span>
                <kbd
                    class="inline-flex h-5 min-w-5 items-center justify-center rounded-xs bg-keycap px-1 font-serif text-xs leading-none text-keycap-foreground"
                >
                    {{ key }}
                </kbd>
            </template>
        </span>
        {{ label }}
    </Primitive>
</template>

<script setup lang="ts">
    import { Primitive } from 'reka-ui';

    import type { ResultPanelShortcut } from './types';

    defineOptions({ name: 'UiResultShortcut' });

    withDefaults(defineProps<ResultPanelShortcut & { as?: 'span' | 'button' }>(), {
        as: 'span',
        separator: undefined,
    });
</script>
