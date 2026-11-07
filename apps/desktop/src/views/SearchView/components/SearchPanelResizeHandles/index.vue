<script setup lang="ts">
    import type { SearchPanelResizeDirection } from '../../panelResizeGeometry';

    defineOptions({ name: 'SearchPanelResizeHandles' });

    defineProps<{
        enabled: boolean;
    }>();

    const emit = defineEmits<{
        'resize-start': [direction: SearchPanelResizeDirection, event: PointerEvent];
    }>();

    const handles: Array<{
        direction: SearchPanelResizeDirection;
        cursor: string;
    }> = [
        { direction: 'n', cursor: 'ns-resize' },
        { direction: 'ne', cursor: 'nesw-resize' },
        { direction: 'e', cursor: 'ew-resize' },
        { direction: 'se', cursor: 'nwse-resize' },
        { direction: 's', cursor: 'ns-resize' },
        { direction: 'sw', cursor: 'nesw-resize' },
        { direction: 'w', cursor: 'ew-resize' },
        { direction: 'nw', cursor: 'nwse-resize' },
    ];

    function handlePointerDown(direction: SearchPanelResizeDirection, event: PointerEvent) {
        if (event.button !== 0) return;

        event.preventDefault();
        event.stopPropagation();
        emit('resize-start', direction, event);
    }
</script>

<template>
    <div
        v-if="enabled"
        data-testid="search-panel-resize-handles"
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 z-50"
    >
        <div
            v-for="handle in handles"
            :key="handle.direction"
            :data-resize-direction="handle.direction"
            :class="[
                'pointer-events-auto absolute touch-none select-none',
                `search-panel-resize-handle--${handle.direction}`,
            ]"
            :style="{ cursor: handle.cursor }"
            @pointerdown="handlePointerDown(handle.direction, $event)"
        ></div>
    </div>
</template>

<style scoped>
    .search-panel-resize-handle--n,
    .search-panel-resize-handle--s {
        right: 12px;
        left: 12px;
        height: 8px;
    }

    .search-panel-resize-handle--n {
        top: 0;
    }

    .search-panel-resize-handle--s {
        bottom: 0;
    }

    .search-panel-resize-handle--e,
    .search-panel-resize-handle--w {
        top: 12px;
        bottom: 12px;
        width: 8px;
    }

    .search-panel-resize-handle--e {
        right: 0;
    }

    .search-panel-resize-handle--w {
        left: 0;
    }

    .search-panel-resize-handle--ne,
    .search-panel-resize-handle--se,
    .search-panel-resize-handle--sw,
    .search-panel-resize-handle--nw {
        z-index: 1;
        width: 12px;
        height: 12px;
    }

    .search-panel-resize-handle--ne {
        top: 0;
        right: 0;
    }

    .search-panel-resize-handle--se {
        right: 0;
        bottom: 0;
    }

    .search-panel-resize-handle--sw {
        bottom: 0;
        left: 0;
    }

    .search-panel-resize-handle--nw {
        top: 0;
        left: 0;
    }
</style>
