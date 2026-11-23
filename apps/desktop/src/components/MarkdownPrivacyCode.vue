<script setup lang="ts">
    import type { CodeBlockNodeProps } from 'markstream-vue';
    import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';

    import { log } from '@/app/api/diagnostics';
    import type { PrivacyReviewAnnotation } from '@/app/api/privacy';
    import AppIcon from '@/components/AppIcon.vue';
    import { Button } from '@/components/ui/button';
    import { t } from '@/i18n';

    import PrivacyProtectionTooltip from './PrivacyProtectionTooltip.vue';

    const props = defineProps<{
        node: CodeBlockNodeProps['node'] & { privacyAnnotations: PrivacyReviewAnnotation[] };
        showHeader: boolean;
    }>();
    const collapsed = ref(false);
    type Token = { start: number; end: number; color?: string };
    const tokens = shallowRef<Token[]>([]);
    let sequence = 0;
    watch(
        () => [props.node.code, props.node.language, props.node.loading] as const,
        async ([code, language, loading]) => {
            const request = ++sequence;
            tokens.value = [];
            if (loading || code.length > 1_000_000) return;
            try {
                // Share the installed renderer's highlighter; Vue owns only annotated text spans.
                const { getSharedHighlighter } = await import('stream-diffs/pierre');
                const lang = language || 'text';
                const highlighter = await getSharedHighlighter({
                    themes: ['one-light'],
                    langs: [lang],
                });
                if (sequence !== request) return;
                const result = highlighter.codeToTokens(code, { lang, theme: 'one-light' });
                let offset = 0;
                const next: Token[] = [];
                for (const line of result.tokens) {
                    for (const token of line) {
                        // The highlighter's source offsets include CRLF and empty lines.
                        if (token.offset > offset) next.push({ start: offset, end: token.offset });
                        next.push({
                            start: token.offset,
                            end: token.offset + token.content.length,
                            color: token.color,
                        });
                        offset = token.offset + token.content.length;
                    }
                }
                if (offset < code.length) next.push({ start: offset, end: code.length });
                tokens.value = next;
            } catch {
                log.warn(
                    '[PrivacyProtection] Code highlighting unavailable; keeping annotated plain text'
                );
            }
        },
        { immediate: true }
    );
    onBeforeUnmount(() => {
        sequence += 1;
    });

    const parts = computed(() => {
        const code = props.node.code;
        const ranges: Array<{ start: number; end: number; annotation?: PrivacyReviewAnnotation }> =
            [];
        let cursor = 0;
        for (const annotation of props.node.privacyAnnotations) {
            if (
                annotation.start < cursor ||
                code.slice(annotation.start, annotation.end) !== annotation.original
            )
                continue;
            if (cursor < annotation.start) ranges.push({ start: cursor, end: annotation.start });
            ranges.push({ start: annotation.start, end: annotation.end, annotation });
            cursor = annotation.end;
        }
        if (cursor < code.length) ranges.push({ start: cursor, end: code.length });
        const highlighted = tokens.value.length ? tokens.value : [{ start: 0, end: code.length }];
        let tokenIndex = 0;
        return ranges.map((range) => {
            while (highlighted[tokenIndex] && highlighted[tokenIndex]!.end <= range.start)
                tokenIndex++;
            const pieces: Array<{ text: string; color?: string }> = [];
            for (let index = tokenIndex; index < highlighted.length; index++) {
                const token = highlighted[index]!;
                if (token.start >= range.end) break;
                pieces.push({
                    text: code.slice(
                        Math.max(range.start, token.start),
                        Math.min(range.end, token.end)
                    ),
                    color: token.color,
                });
            }
            return { annotation: range.annotation, pieces };
        });
    });
</script>

<template>
    <div class="overflow-hidden rounded-md border border-border-subtle bg-surface-sunken">
        <div
            v-if="showHeader"
            class="flex min-h-10 items-center justify-between px-3 pr-12 text-xs text-text-secondary"
        >
            <span>{{ node.language }}</span>
            <Button
                variant="ghost-neutral"
                :aria-label="
                    t(collapsed ? 'conversation.message.expand' : 'conversation.message.collapse')
                "
                :aria-pressed="collapsed"
                @click="collapsed = !collapsed"
            >
                <AppIcon :name="collapsed ? 'chevron-down' : 'chevron-up'" class="h-4 w-4" />
            </Button>
        </div>
        <pre
            v-show="!collapsed"
            class="custom-scrollbar m-0 overflow-auto p-4 font-mono text-sm leading-5"
        ><code><template v-for="(part, index) in parts" :key="index"><PrivacyProtectionTooltip v-if="part.annotation" :annotation="part.annotation"><span v-for="(piece, i) in part.pieces" :key="i" :style="{ color: piece.color }">{{ piece.text }}</span></PrivacyProtectionTooltip><template v-else><span v-for="(piece, i) in part.pieces" :key="i" :style="{ color: piece.color }">{{ piece.text }}</span></template></template></code></pre>
    </div>
</template>
