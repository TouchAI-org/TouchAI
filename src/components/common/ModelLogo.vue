<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import { computed } from 'vue';

    interface ModelLogoMapping {
        logo: string;
        keywords: string[];
    }

    const MODEL_LOGO_MAPPINGS: ModelLogoMapping[] = [
        { logo: 'openai.png', keywords: ['openai', 'gpt', 'o1', 'o3', 'o4'] },
        { logo: 'claude.png', keywords: ['claude', 'anthropic'] },
        { logo: 'gemini.png', keywords: ['gemini', 'google'] },
        { logo: 'deepseek.png', keywords: ['deepseek'] },
        { logo: 'qwen.png', keywords: ['qwen', 'tongyi', '通义', 'qwq', 'qvq'] },
        { logo: 'zhipu.png', keywords: ['glm', 'zhipu', 'chatglm', '智谱', 'z-ai', 'zai'] },
        { logo: 'moonshot.png', keywords: ['moonshot', 'kimi'] },
        { logo: 'doubao.png', keywords: ['doubao', '豆包'] },
        { logo: 'hunyuan.png', keywords: ['hunyuan', '混元'] },
        { logo: 'minimax.png', keywords: ['minimax', 'abab'] },
        { logo: 'grok.png', keywords: ['grok'] },
        { logo: 'llama.png', keywords: ['llama', 'meta'] },
        { logo: 'longcat.png', keywords: ['longcat'] },
        { logo: 'mimo.png', keywords: ['mimo', 'xiaomi'] },
        { logo: 'cohere.png', keywords: ['cohere', 'command'] },
        { logo: 'gemma.png', keywords: ['gemma'] },
        { logo: 'mistral.png', keywords: ['mistral'] },
    ];

    // 使用 Vite 的 glob import 预加载所有模型 logo
    const modelLogos = import.meta.glob<{ default: string }>('../../assets/logos/models/*', {
        eager: true,
    });

    interface Props {
        modelId: string;
        name?: string;
        size?: 'sm' | 'md' | 'lg';
    }

    const props = withDefaults(defineProps<Props>(), {
        name: '',
        size: 'md',
    });

    const sizeClass = computed(() => {
        switch (props.size) {
            case 'sm':
                return 'h-6 w-6';
            case 'lg':
                return 'h-10 w-10';
            default:
                return 'h-8 w-8';
        }
    });

    const fallbackTextClass = computed(() => {
        switch (props.size) {
            case 'sm':
                return 'text-[10px]';
            case 'lg':
                return 'text-sm';
            default:
                return 'text-xs';
        }
    });

    const logoSrc = computed(() => {
        if (!props.modelId) return null;

        const lowerModelId = props.modelId.toLowerCase();
        let logoFileName: string | null = null;

        for (const mapping of MODEL_LOGO_MAPPINGS) {
            for (const keyword of mapping.keywords) {
                if (lowerModelId.includes(keyword.toLowerCase())) {
                    logoFileName = mapping.logo;
                    break;
                }
            }
            if (logoFileName) break;
        }

        if (!logoFileName) return null;

        const path = `../../assets/logos/models/${logoFileName}`;
        return modelLogos[path]?.default || null;
    });

    const fallbackChar = computed(() => {
        return (props.name || props.modelId || '?').charAt(0);
    });
</script>

<template>
    <img
        v-if="logoSrc"
        :src="logoSrc"
        :alt="name || modelId"
        :class="[sizeClass, 'rounded-full object-cover']"
    />
    <div
        v-else
        :class="[
            sizeClass,
            fallbackTextClass,
            'flex items-center justify-center rounded-full bg-gray-100 font-semibold text-gray-500',
        ]"
    >
        {{ fallbackChar }}
    </div>
</template>
