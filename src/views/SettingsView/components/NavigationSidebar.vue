<script setup lang="ts">
    import SvgIcon from '@components/SvgIcon.vue';

    export type NavigationSection =
        | 'general'
        | 'ai-services'
        | 'mcp-tools'
        | 'built-in-tools'
        | 'data-management'
        | 'about';

    interface NavigationItem {
        id: NavigationSection;
        icon: string;
        label: string;
    }

    interface Props {
        activeSection: NavigationSection;
    }

    interface Emits {
        (e: 'navigate', section: NavigationSection): void;
    }

    defineProps<Props>();
    const emit = defineEmits<Emits>();

    const navigationItems: NavigationItem[] = [
        { id: 'general', icon: 'settings', label: '常规设置' },
        { id: 'ai-services', icon: 'llm', label: '大模型服务设置' },
        { id: 'built-in-tools', icon: 'tool', label: '内置工具' },
        { id: 'mcp-tools', icon: 'mcp', label: 'MCP 工具' },
        { id: 'data-management', icon: 'database', label: '数据管理' },
        { id: 'about', icon: 'information-circle', label: '关于' },
    ];

    const handleNavigate = (section: NavigationSection) => {
        emit('navigate', section);
    };
</script>

<template>
    <div class="flex w-16 flex-col items-center space-y-2 border-r border-gray-200 bg-white/80 p-2">
        <button
            v-for="item in navigationItems"
            :key="item.id"
            :class="[
                'flex h-12 w-12 cursor-pointer items-center justify-center rounded-lg transition-colors',
                activeSection === item.id
                    ? 'bg-primary-50 text-primary-600'
                    : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600',
            ]"
            :title="item.label"
            @click="handleNavigate(item.id)"
        >
            <SvgIcon :name="item.icon" class="h-6 w-6" />
        </button>
    </div>
</template>
