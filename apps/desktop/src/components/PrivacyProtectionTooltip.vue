<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { Tooltip, TooltipContent, TooltipTrigger } from '@components/ui/tooltip';
    import { computed, ref } from 'vue';

    import type { PrivacyReviewAnnotation } from '@/app/api/privacy';
    import { type MessageKey, t } from '@/i18n';
    import { privacyProtectionKindLabels } from '@/views/SettingsView/components/PrivacyFilter/privacyProtectionLabels';

    const props = withDefaults(
        defineProps<{ annotation: PrivacyReviewAnnotation; open?: boolean }>(),
        { open: undefined }
    );
    const emit = defineEmits<{ 'update:open': [value: boolean] }>();
    const localOpen = ref(false);
    const isRestoration = computed(() => String(props.annotation.messageId).startsWith('reply:'));
    const triggerElement = ref<HTMLElement | null>(null);
    // The transparent native host extends beyond the visible search card.
    const collisionBoundary = computed(() =>
        triggerElement.value?.closest('.search-view-container')
    );
    const isOpen = computed({
        get: () => props.open ?? localOpen.value,
        set: (value: boolean) => {
            localOpen.value = value;
            emit('update:open', value);
        },
    });
    function closeOnEscape(event: KeyboardEvent) {
        if (!isOpen.value) return;
        event.stopPropagation();
        event.preventDefault();
        isOpen.value = false;
    }
    const ruleKeys: Record<string, MessageKey> = {
        privateKey: 'conversation.privacy.privateKey',
        apiKey: 'conversation.privacy.apiKey',
        jwt: 'conversation.privacy.jwt',
        secretAssignment: 'conversation.privacy.secretField',
        urlPassword: 'conversation.privacy.urlPassword',
        email: 'conversation.privacy.email',
        phone: 'settings.privacyFilter.type.phone',
        chinaId: 'conversation.privacy.chinaId',
        paymentCard: 'settings.privacyFilter.type.paymentCard',
    };
    const tags = computed(() => {
        const rule = props.annotation.rule;
        if (!rule) return [t('conversation.privacy.unknown')];
        if (rule.id === 'localModel')
            return [
                t('conversation.privacy.model'),
                t(privacyProtectionKindLabels[props.annotation.kind]),
            ];
        if (rule.id === 'customWord')
            return [
                t('conversation.privacy.custom'),
                t('settings.privacyFilter.rule.customWordShort'),
            ];
        if (rule.id === 'customPrefix')
            return [
                t('conversation.privacy.custom'),
                t('settings.privacyFilter.rule.customPrefixShort'),
            ];
        return [t('conversation.privacy.builtin'), t(ruleKeys[rule.id]!)];
    });
</script>

<template>
    <Tooltip v-model:open="isOpen" :disable-closing-trigger="true">
        <TooltipTrigger as-child>
            <span
                ref="triggerElement"
                tabindex="0"
                role="button"
                class="cursor-text underline decoration-text-tertiary/40 decoration-dashed decoration-subtle underline-offset-4 focus-visible:decoration-text-secondary focus-visible:decoration-solid"
                :aria-label="t('conversation.privacy.trigger')"
                data-testid="privacy-protected-text"
                data-privacy-protection="trigger"
                @click.stop="isOpen = true"
                @keydown.enter.stop.prevent="isOpen = true"
                @keydown.space.stop.prevent="isOpen = true"
                @keydown.esc="closeOnEscape"
            >
                <slot>{{ annotation.original }}</slot>
            </span>
        </TooltipTrigger>
        <TooltipContent
            variant="privacy"
            :collision-boundary="collisionBoundary"
            data-testid="privacy-protection-tooltip"
            data-privacy-protection="tooltip"
            @escape-key-down="closeOnEscape"
        >
            <div class="space-y-1">
                <div class="flex items-center gap-1.5 text-caption leading-4 contain-inline-size">
                    <span class="flex items-center gap-1.5">
                        <span
                            class="font-medium text-text-primary"
                            data-testid="privacy-protection-tag"
                        >
                            {{ tags[0] }}
                        </span>
                        <template v-if="tags[1]">
                            <span class="text-text-tertiary" aria-hidden="true">/</span>
                            <span class="text-text-secondary" data-testid="privacy-protection-tag">
                                {{ tags[1] }}
                            </span>
                        </template>
                    </span>
                    <span
                        class="ml-auto flex items-center gap-1 text-text-tertiary"
                        data-testid="privacy-protection-shield"
                    >
                        <AppIcon name="shield-check" class="h-3 w-3 shrink-0" />
                        <span>
                            {{
                                t(
                                    isRestoration
                                        ? 'conversation.privacy.restoredShort'
                                        : 'conversation.privacy.protectedShort'
                                )
                            }}
                        </span>
                    </span>
                </div>
                <div class="flex items-baseline gap-1.5 text-caption leading-4">
                    <span class="shrink-0 text-text-tertiary">
                        {{
                            t(
                                isRestoration
                                    ? 'conversation.privacy.returnedAs'
                                    : 'conversation.privacy.sentAs'
                            )
                        }}
                    </span>
                    <div
                        class="min-w-0 text-caption leading-4 break-words whitespace-pre-wrap text-text-primary"
                        data-testid="privacy-protection-placeholder"
                        data-no-i18n="true"
                        translate="no"
                    >
                        {{ annotation.placeholder }}
                    </div>
                </div>
            </div>
        </TooltipContent>
    </Tooltip>
</template>
