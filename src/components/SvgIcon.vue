<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { computed, ref } from 'vue';

    interface Props {
        name: string;
        class?: string;
    }

    const props = defineProps<Props>();

    // 使用 Vite 的 glob 导入功能动态加载所有 SVG 图标
    const iconModules = import.meta.glob<string>('@assets/icons/*.svg', {
        query: '?raw',
        import: 'default',
        eager: true,
    });

    // 提取图标内容（去除 SVG 外层标签，只保留内部内容）
    const icons = ref<Record<string, { content: string; viewBox: string; useStroke: boolean }>>({});

    // 处理导入的 SVG 文件
    Object.entries(iconModules).forEach(([path, content]) => {
        // 从路径中提取文件名（不含扩展名）
        const fileName = path.match(/\/([^/]+)\.svg$/)?.[1];
        if (fileName && content) {
            // 提取 viewBox 属性
            const viewBoxMatch = content.match(/viewBox=["']([^"']+)["']/);
            const viewBox = (viewBoxMatch?.[1] ?? '0 0 24 24') as string;

            // 提取 SVG 内部内容（path 标签，支持自闭合和非自闭合形式）
            const match = content.match(/<path[^>]*(?:\/>|>[^<]*<\/path>)/g);
            if (match) {
                // 检查 path 是否有 stroke 属性（用于判断是 stroke 类型还是 fill 类型的图标）
                const hasStroke = match.some((path) => /stroke[-=]/.test(path));

                icons.value[fileName] = {
                    content: match.join(''),
                    viewBox,
                    useStroke: hasStroke,
                };
            }
        }
    });

    // 获取当前图标的内容和 viewBox
    const iconContent = computed(() => icons.value[props.name]?.content || '');
    const iconViewBox = computed<string>(() => icons.value[props.name]?.viewBox || '0 0 24 24');
    const useStroke = computed(() => icons.value[props.name]?.useStroke ?? true);
</script>

<template>
    <svg
        :class="props.class"
        :fill="useStroke ? 'none' : 'currentColor'"
        :viewBox="iconViewBox"
        :stroke="useStroke ? 'currentColor' : 'none'"
        xmlns="http://www.w3.org/2000/svg"
        v-html="iconContent"
    />
</template>
