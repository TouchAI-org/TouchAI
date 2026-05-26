<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
  <div ref="markdownContainerRef" :class="containerClass" @click="handleMarkdownClick">
    <MarkdownRender
      :content="stableContent"
      :final="props.final"
      :is-dark="false"
      :themes="codeBlockThemes"
      :code-block-light-theme="codeBlockLightTheme"
      :code-block-dark-theme="codeBlockDarkTheme"
      :code-block-monaco-options="codeBlockMonacoOptions"
      :max-live-nodes="maxLiveNodes"
      :batch-rendering="true"
      :initial-render-batch-size="24"
      :render-batch-size="16"
      :render-batch-delay="8"
      :render-batch-budget-ms="6"
      :typewriter="isTypewriterEnabled"
      :code-block-props="codeBlockProps"
      :preserve-code-block-scroll="true"
      :code-block-auto-scroll="false"
      @render-finished="onRenderFinished"
    />
  </div>
</template>

<script setup lang="ts">
import { notify } from '@services/NotificationService';
import MarkdownRender from 'markstream-vue';
import { computed, ref, watch, nextTick } from 'vue';
import { clipboardService } from '@/services/ClipboardService';

// 导入 markdown 解析器配置（假设你已有，按实际路径调整）
import { getTouchAiMarkdownParser } from '@/utils/markdownParser';

interface Props {
  content: string;
  variant?: 'default' | 'reasoning';
  final?: boolean;
  'is-new-message'?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'default',
  final: true,
  'is-new-message': false,
});

const containerClass = computed(() => {
  return props.variant === 'reasoning'
    ? 'touchai-markdown touchai-markdown--reasoning'
    : 'touchai-markdown touchai-markdown--default select-text';
});

const markdownContainerRef = ref<HTMLElement | null>(null);

// ========== 1. 防止相同内容的不同引用导致重渲染 ==========
let lastRawContent = '';
const stableContent = computed(() => {
  // 只在实际内容变化时才更新，否则返回上次的相同字符串（Vue 会跳过渲染）
  if (props.content !== lastRawContent) {
    lastRawContent = props.content;
  }
  return lastRawContent;
});

// ========== 2. 流式结束后重置滚动条位置（上/左） ==========
let lastFinal = props.final;

async function resetCodeBlocksScroll() {
  await nextTick();
  const container = markdownContainerRef.value;
  if (!container) return;

  // 查找所有代码块容器
  const codeBlocks = container.querySelectorAll('.code-block-container');
  for (const block of codeBlocks) {
    // 尝试多种可能的滚动容器选择器（兼容 markstream-vue 内部实现）
    const selectors = [
      '.monaco-editor .overflow-guard',
      '.monaco-scrollable-element',
      '.code-scroll-container',
      '[class*="code-scroll"]'
    ];
    let scrollContainer: HTMLElement | null = null;
    for (const sel of selectors) {
      scrollContainer = block.querySelector(sel) as HTMLElement;
      if (scrollContainer) break;
    }
    if (scrollContainer) {
      scrollContainer.scrollTop = 0;
      scrollContainer.scrollLeft = 0;
    }
  }
}

watch(
  () => props.final,
  async (newFinal) => {
    // 仅在 final 从 false → true（流式结束）时重置滚动
    if (newFinal && !lastFinal) {
      // 等待 DOM 更新完成，并给渲染一点额外时间
      await nextTick();
      requestAnimationFrame(() => resetCodeBlocksScroll());
    }
    lastFinal = newFinal;
  }
);

// 渲染完成事件（二次保险）
function onRenderFinished() {
  if (props.final) {
    resetCodeBlocksScroll();
  }
}

// ========== 3. 新消息发送时，只重置内容缓存，避免旧消息闪烁 ==========
watch(
  () => props['is-new-message'],
  (isNew) => {
    if (isNew) {
      // 清除内容缓存，让新消息重新解析，但旧消息组件不会因为 props.content 未变而重渲染
      lastRawContent = '';
      // 注意：不要重置 lastFinal，否则会影响滚动重置逻辑
    }
  }
);

// ========== 4. 行内代码点击复制（保留原有功能） ==========
async function handleMarkdownClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (!target) return;

  const codeElement = target.closest('code');
  if (!codeElement) return;
  if (codeElement.closest('pre') || codeElement.closest('.code-block-container')) return;

  const text = codeElement.textContent?.trim();
  if (!text) return;

  try {
    await clipboardService.writeText(text);
    notify({ title: 'TouchAI', body: '已复制' });
  } catch (error) {
    console.error('[MarkdownContent] 复制失败', error);
    notify({ title: 'TouchAI', body: '复制失败' });
  }
}

// ========== 5. 其他配置（不变） ==========
const maxLiveNodes = computed(() => (props.variant === 'reasoning' ? 320 : 0));
const isTypewriterEnabled = computed(() => props.variant !== 'reasoning');

const codeBlockProps = Object.freeze({
  showHeader: true,
  showCopyButton: true,
  showExpandButton: false,
  showPreviewButton: false,
  showFontSizeButtons: false,
  overflowBehavior: 'stable', // 避免滚动条出现/消失导致布局抖动
});

const codeBlockMonacoOptions = Object.freeze({
  glyphMargin: false,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  minimap: { enabled: false },
});

const codeBlockLightTheme = 'one-light';
const codeBlockDarkTheme = 'one-dark-pro';
const codeBlockThemes = [codeBlockLightTheme, codeBlockDarkTheme];
</script>SSSss
