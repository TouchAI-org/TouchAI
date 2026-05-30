<!--
  Ported from https://www.fluidfunctionalism.com/r/ask-user-questions.json
  Upstream: registry/default/ask-user-questions.tsx
  Adaptations:
    - React -> Vue 3 SFC (Composition API)
    - framer-motion -> motion-v (1:1 API)
    - shadcn color tokens bridged to TouchAI primary palette via tokens.css
    - Inter variable-font weights -> Source Han Serif fixed weights
    - Removed: shape pill mode (rounded only), R/I global shortcuts
    - Icons: AppIcon system instead of lucide-react
-->

<template>
    <div class="flex w-full min-w-0 justify-center px-10">
        <div
            ref="rootRef"
            tabindex="-1"
            class="ask-user-questions-root bg-card border-border relative w-full max-w-[700px] min-w-0 overflow-hidden rounded-t-2xl border border-b-0"
            @keydown="handleRootKey"
        >
            <!-- Header -->
            <div
                v-if="total > 1"
                class="ask-content-x text-muted-foreground flex items-center pt-5 pb-2 text-[12px]"
            >
                <span>{{ safeIndex + 1 }} / {{ total }}</span>
            </div>

            <!-- Morphing Q/A region -->
            <motion.div
                :animate="{ height: contentHeight }"
                :initial="false"
                :transition="springs.slow"
                class="overflow-hidden"
            >
                <div
                    ref="contentMeasureRef"
                    :class="[
                        'ask-content-x',
                        total > 1 ? '' : 'pt-4',
                        showFooter ? 'pb-1' : 'pb-3',
                    ]"
                >
                    <div :key="qId" class="flex flex-col gap-3">
                        <!-- Question title -->
                        <h3
                            :id="`${uid}-${qId}-title`"
                            class="text-foreground pt-1 pb-1 text-[14px] leading-snug"
                            :style="{ fontWeight: fontWeights.semibold }"
                        >
                            {{ question?.title }}
                        </h3>

                        <!-- Optional subtitle / reason -->
                        <p
                            v-if="question?.subtitle"
                            class="text-muted-foreground -mt-2 text-[13px] leading-relaxed"
                        >
                            {{ question.subtitle }}
                        </p>

                        <!-- Optional command preview -->
                        <pre
                            v-if="question?.commandPreview"
                            class="custom-scrollbar-thin border-border bg-accent/40 text-foreground -mt-1 max-h-[8rem] overflow-auto rounded-lg border px-3 py-2 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap"
                            >{{ question.commandPreview }}</pre
                        >

                        <!-- Options container -->
                        <div
                            ref="rowsContainerRef"
                            :role="isMulti ? 'group' : 'radiogroup'"
                            :aria-labelledby="`${uid}-${qId}-title`"
                            class="ask-rows-extend relative flex flex-col gap-0.5"
                            @mouseenter="handlers.onMouseEnter"
                            @mousemove="handlers.onMouseMove"
                            @mouseleave="handlers.onMouseLeave"
                        >
                            <!-- Other-row input hint (empty focused state) -->
                            <AnimatePresence>
                                <motion.div
                                    v-if="
                                        allowOther &&
                                        itemRects[otherIndex] &&
                                        focusedIndex === otherIndex &&
                                        otherText.length === 0
                                    "
                                    key="other-input"
                                    aria-hidden
                                    :class="[
                                        'bg-card ring-border pointer-events-none absolute ring-1 ring-inset',
                                        shape.bg,
                                    ]"
                                    :initial="{
                                        opacity: 0,
                                        top: itemRects[otherIndex]?.top,
                                        left: itemRects[otherIndex]?.left,
                                        width: itemRects[otherIndex]?.width,
                                        height: itemRects[otherIndex]?.height,
                                    }"
                                    :animate="{
                                        opacity: 1,
                                        top: itemRects[otherIndex]?.top,
                                        left: itemRects[otherIndex]?.left,
                                        width: itemRects[otherIndex]?.width,
                                        height: itemRects[otherIndex]?.height,
                                    }"
                                    :exit="{ opacity: 0, transition: { duration: 0.08 } }"
                                    :transition="{ ...springs.fast, opacity: { duration: 0.08 } }"
                                />
                            </AnimatePresence>

                            <!-- Single morphing hover indicator -->
                            <AnimatePresence>
                                <motion.div
                                    v-if="activeRect"
                                    :key="`hover-${sessionRef}`"
                                    aria-hidden
                                    :class="['bg-hover pointer-events-none absolute', shape.bg]"
                                    :initial="{
                                        opacity: 0,
                                        top: activeRect.top,
                                        left: activeRect.left,
                                        width: activeRect.width,
                                        height: activeRect.height,
                                    }"
                                    :animate="{
                                        opacity: 1,
                                        top: activeRect.top,
                                        left: activeRect.left,
                                        width: activeRect.width,
                                        height: activeRect.height,
                                    }"
                                    :exit="{ opacity: 0, transition: { duration: 0.06 } }"
                                    :transition="{ ...springs.fast, opacity: { duration: 0.08 } }"
                                />
                            </AnimatePresence>

                            <!-- Selected-row backgrounds (merged contiguous) -->
                            <AnimatePresence>
                                <motion.div
                                    v-for="group in selectedGroups"
                                    :key="`selected-${group.id}`"
                                    aria-hidden
                                    :class="['bg-active pointer-events-none absolute', shape.bg]"
                                    :initial="false"
                                    :animate="{
                                        top: itemRects[group.start]?.top ?? 0,
                                        left: Math.min(
                                            itemRects[group.start]?.left ?? 0,
                                            itemRects[group.end]?.left ?? 0
                                        ),
                                        width: Math.max(
                                            itemRects[group.start]?.width ?? 0,
                                            itemRects[group.end]?.width ?? 0
                                        ),
                                        height:
                                            (itemRects[group.end]?.top ?? 0) +
                                            (itemRects[group.end]?.height ?? 0) -
                                            (itemRects[group.start]?.top ?? 0),
                                        opacity: isHoveringNonSelected ? 0.8 : 1,
                                    }"
                                    :exit="{ opacity: 0, transition: { duration: 0.12 } }"
                                    :transition="{
                                        ...springs.moderate,
                                        opacity: { duration: 0.08 },
                                    }"
                                />
                            </AnimatePresence>

                            <!-- Option rows -->
                            <Row
                                v-for="(opt, i) in options"
                                :key="optionKey(opt, i)"
                                :index="i"
                                :register-item="registerItem"
                                :role="isMulti ? 'checkbox' : 'radio'"
                                :is-selected="selectedIds.includes(optionKey(opt, i))"
                                :tab-index="
                                    isMulti
                                        ? 0
                                        : selectedIds[0] === optionKey(opt, i) ||
                                            (!selectedIds.length && i === 0)
                                          ? 0
                                          : -1
                                "
                                :on-focus-visible="() => setActiveIndex(i)"
                                :on-blur-any="
                                    () => setActiveIndex((prev) => (prev === i ? null : prev))
                                "
                                :on-click="
                                    () =>
                                        isMulti
                                            ? handleMultiToggle(optionKey(opt, i))
                                            : handleSingleSelect(optionKey(opt, i))
                                "
                                :on-key-down="
                                    (e: KeyboardEvent) => {
                                        if (
                                            (e.key === ' ' || e.key === 'Enter') &&
                                            !e.metaKey &&
                                            !e.ctrlKey
                                        ) {
                                            e.preventDefault();
                                            if (isMulti) handleMultiToggle(optionKey(opt, i));
                                            else handleSingleSelect(optionKey(opt, i));
                                        }
                                    }
                                "
                                :aria-checked="selectedIds.includes(optionKey(opt, i))"
                                :chip-content="i + 1"
                                :chip-filled="selectedIds.includes(optionKey(opt, i))"
                                :is-multi="isMulti"
                                :show-arrow="!isMulti && activeIndex === i"
                                :body-layout="question?.layout === 'stacked' ? 'stacked' : 'inline'"
                            >
                                <template v-if="question?.layout === 'stacked'">
                                    <span
                                        class="text-foreground transition-colors duration-80"
                                        :style="{
                                            fontWeight: selectedIds.includes(optionKey(opt, i))
                                                ? fontWeights.semibold
                                                : fontWeights.medium,
                                        }"
                                    >
                                        {{ opt.title }}
                                    </span>
                                    <span
                                        v-if="opt.description"
                                        class="text-muted-foreground truncate text-[12px] leading-snug"
                                    >
                                        {{ opt.description }}
                                    </span>
                                </template>
                                <template v-else>
                                    <span>
                                        <span
                                            class="text-foreground transition-colors duration-80"
                                            :style="{
                                                fontWeight: selectedIds.includes(optionKey(opt, i))
                                                    ? fontWeights.semibold
                                                    : fontWeights.medium,
                                            }"
                                        >
                                            {{ opt.title }}
                                        </span>
                                        <template v-if="opt.description">
                                            {{ ' ' }}
                                            <span class="text-muted-foreground">
                                                {{ opt.description }}
                                            </span>
                                        </template>
                                    </span>
                                </template>
                            </Row>

                            <!-- Other row -->
                            <Row
                                v-if="allowOther"
                                :index="otherIndex"
                                :register-item="registerItem"
                                :role="null"
                                :is-selected="otherText.length > 0"
                                :tab-index="-1"
                                :on-focus-visible="() => (focusedIndex = otherIndex)"
                                :on-blur-any="
                                    () => {
                                        if (focusedIndex === otherIndex) focusedIndex = null;
                                    }
                                "
                                :on-click="() => otherInputRef?.focus()"
                                :aria-label="
                                    question?.otherPlaceholder ?? 'Describe in your own words'
                                "
                                :chip-content="otherIndex + 1"
                                :chip-filled="otherText.length > 0"
                                :is-multi="isMulti"
                                :show-arrow="
                                    !isMulti &&
                                    (focusedIndex === otherIndex || activeIndex === otherIndex) &&
                                    otherText.trim().length > 0
                                "
                                :on-arrow-click="
                                    !isMulti && otherText.trim().length > 0
                                        ? handleOtherSubmit
                                        : undefined
                                "
                            >
                                <span class="inline-grid w-full">
                                    <input
                                        ref="otherInputRef"
                                        type="text"
                                        :value="otherText"
                                        :placeholder="
                                            question?.otherPlaceholder ??
                                            'Describe in your own words…'
                                        "
                                        :aria-label="
                                            question?.otherPlaceholder ??
                                            'Describe in your own words'
                                        "
                                        class="text-foreground placeholder:text-muted-foreground col-start-1 row-start-1 w-full bg-transparent text-[13px] outline-none"
                                        :style="{ fontWeight: fontWeights.medium }"
                                        @input="
                                            (e) =>
                                                handleOtherChange(
                                                    (e.target as HTMLInputElement).value
                                                )
                                        "
                                        @focus="focusedIndex = otherIndex"
                                        @blur="
                                            () => {
                                                if (focusedIndex === otherIndex)
                                                    focusedIndex = null;
                                            }
                                        "
                                        @keydown="
                                            (e) => {
                                                if (e.key === 'Enter' && !isMulti) {
                                                    e.preventDefault();
                                                    handleOtherSubmit();
                                                }
                                            }
                                        "
                                        @click.stop
                                    />
                                </span>
                            </Row>
                        </div>
                    </div>
                </div>
            </motion.div>

            <!-- Footer -->
            <div v-if="showFooter" class="ask-footer-x pt-1 pb-2">
                <div class="flex items-center justify-between gap-2">
                    <!-- Left: Back button -->
                    <div class="relative flex items-center gap-2">
                        <AnimatePresence :initial="false">
                            <motion.div
                                v-if="showBack"
                                key="back"
                                layout="position"
                                :initial="{ opacity: 0, scale: 0.85 }"
                                :animate="{ opacity: 1, scale: 1 }"
                                :exit="{ opacity: 0, scale: 0.85 }"
                                :transition="{ ...springs.fast, opacity: { duration: 0.1 } }"
                            >
                                <AskButton variant="ghost" @click="handleBack">
                                    <template #default>
                                        <span class="inline-flex items-center gap-1.5">
                                            <AppIcon
                                                name="arrow-left"
                                                class="hidden h-3.5 w-3.5 sm:block"
                                            />
                                            Back
                                        </span>
                                    </template>
                                </AskButton>
                            </motion.div>
                        </AnimatePresence>
                    </div>

                    <!-- Right: Skip + Continue buttons -->
                    <div class="relative flex items-center gap-2">
                        <AnimatePresence :initial="false">
                            <motion.div
                                v-if="showSkip"
                                key="skip"
                                layout="position"
                                :initial="{ opacity: 0, scale: 0.85 }"
                                :animate="{ opacity: 1, scale: 1 }"
                                :exit="{ opacity: 0, scale: 0.85 }"
                                :transition="{ ...springs.fast, opacity: { duration: 0.1 } }"
                            >
                                <AskButton variant="ghost" @click="handleSkip">
                                    <template #default>
                                        <span class="inline-flex items-center gap-1.5">
                                            {{ props.skipLabel }}
                                            <AppIcon
                                                name="arrow-right"
                                                class="hidden h-3.5 w-3.5 sm:block"
                                            />
                                        </span>
                                    </template>
                                </AskButton>
                            </motion.div>

                            <motion.div
                                v-if="isMulti"
                                key="continue"
                                layout="position"
                                :initial="{ opacity: 0, scale: 0.85 }"
                                :animate="{ opacity: 1, scale: 1 }"
                                :exit="{ opacity: 0, scale: 0.85 }"
                                :transition="{ ...springs.fast, opacity: { duration: 0.1 } }"
                            >
                                <AskButton
                                    variant="primary"
                                    :disabled="
                                        selectedIds.length === 0 && otherText.trim().length === 0
                                    "
                                    @click="handleMultiNext"
                                >
                                    <template #default>
                                        <span class="inline-flex items-center gap-1.5">
                                            {{
                                                question?.nextLabel ??
                                                (safeIndex >= total - 1 ? 'Finish' : 'Continue')
                                            }}
                                            <span class="hidden sm:contents">
                                                <ShortcutChip tone="inverted">
                                                    {{ modifierSymbol }}↵
                                                </ShortcutChip>
                                            </span>
                                        </span>
                                    </template>
                                </AskButton>
                            </motion.div>
                        </AnimatePresence>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { AnimatePresence, motion } from 'motion-v';
    import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue';

    import { useProximityHover } from './composables/useProximityHover';
    import { fontWeights } from './lib/fontWeights';
    import { shape } from './lib/shape';
    import { springs } from './lib/springs';
    import AskButton from './parts/Button.vue';
    import Row from './parts/Row.vue';
    import ShortcutChip from './parts/ShortcutChip.vue';

    // -- Types --

    export interface AskUserOption {
        id?: string;
        title: string;
        description?: string;
        disabled?: boolean;
    }

    export interface AskUserQuestion {
        id?: string;
        title: string;
        subtitle?: string;
        commandPreview?: string;
        options: AskUserOption[];
        multiSelect?: boolean;
        allowOther?: boolean;
        otherPlaceholder?: string;
        skippable?: boolean;
        nextLabel?: string;
        layout?: 'inline' | 'stacked';
    }

    export interface AskUserAnswer {
        questionId: string;
        selectedIds: string[];
        otherText?: string;
        skipped?: boolean;
    }

    // -- Props & Emits --

    interface Props {
        questions: AskUserQuestion[];
        currentIndex?: number;
        defaultCurrentIndex?: number;
        answers?: Record<string, AskUserAnswer>;
        defaultAnswers?: Record<string, AskUserAnswer>;
        skipLabel?: string;
    }

    const props = withDefaults(defineProps<Props>(), {
        defaultCurrentIndex: 0,
        skipLabel: 'Skip',
    });

    const emit = defineEmits<{
        'update:currentIndex': [index: number];
        'update:answers': [answers: Record<string, AskUserAnswer>];
        complete: [answers: Record<string, AskUserAnswer>];
        skip: [questionId: string, currentIndex: number];
        cancel: [];
    }>();

    // -- Controlled / uncontrolled index --

    const internalIndex = ref(props.defaultCurrentIndex);
    const isIndexControlled = computed(() => props.currentIndex !== undefined);
    const index = computed(() =>
        isIndexControlled.value ? (props.currentIndex as number) : internalIndex.value
    );
    function setIndex(next: number): void {
        if (!isIndexControlled.value) internalIndex.value = next;
        emit('update:currentIndex', next);
    }

    // -- Controlled / uncontrolled answers --

    const internalAnswers = ref<Record<string, AskUserAnswer>>(props.defaultAnswers ?? {});
    const isAnswersControlled = computed(() => props.answers !== undefined);
    const answers = computed(() =>
        isAnswersControlled.value
            ? (props.answers as Record<string, AskUserAnswer>)
            : internalAnswers.value
    );

    function writeAnswers(
        updater: (prev: Record<string, AskUserAnswer>) => Record<string, AskUserAnswer>
    ): Record<string, AskUserAnswer> {
        const next = updater(answers.value);
        if (!isAnswersControlled.value) internalAnswers.value = next;
        emit('update:answers', next);
        return next;
    }

    // -- Derived state --

    const uid = useId();
    const total = computed(() => props.questions.length);
    const safeIndex = computed(() =>
        Math.max(0, Math.min(index.value, Math.max(0, total.value - 1)))
    );
    const question = computed(() => props.questions[safeIndex.value]);
    const qId = computed(() => {
        const q = question.value;
        return q ? (q.id ?? `q-${safeIndex.value}`) : '';
    });
    const currentAnswer = computed(() => answers.value[qId.value]);

    const isMulti = computed(() => !!question.value?.multiSelect);
    const isSkippable = computed(() => question.value?.skippable !== false);
    const allowOther = computed(() => !!question.value?.allowOther);
    const selectedIds = computed(() => currentAnswer.value?.selectedIds ?? []);
    const otherText = computed(() => currentAnswer.value?.otherText ?? '');

    const options = computed(() => question.value?.options ?? []);
    const otherIndex = computed(() => (allowOther.value ? options.value.length : -1));
    const rowCount = computed(() => options.value.length + (allowOther.value ? 1 : 0));

    function optionKey(o: AskUserOption, i: number): string {
        return o.id ?? `o-${i}`;
    }

    // -- Refs & proximity hover --

    const rootRef = ref<HTMLDivElement | null>(null);
    const rowsContainerRef = ref<HTMLDivElement | null>(null);
    const otherInputRef = ref<HTMLInputElement | null>(null);
    const contentMeasureRef = ref<HTMLDivElement | null>(null);

    const groupIdCounterRef = ref(0);
    const prevGroupMapRef = ref(new Map<number, number>());

    const {
        activeIndex,
        setActiveIndex,
        itemRects,
        sessionRef,
        handlers,
        registerItem,
        measureItems,
    } = useProximityHover(rowsContainerRef);

    // Remeasure on row count change or question change
    watch([qId, rowCount], () => {
        nextTick(() => measureItems());
    });

    // -- Animated height --

    const contentHeight = ref<number | 'auto'>('auto');
    let resizeObserver: ResizeObserver | null = null;

    onMounted(() => {
        const el = contentMeasureRef.value;
        if (!el) return;
        const update = () => {
            contentHeight.value = el.offsetHeight;
        };
        update();
        resizeObserver = new ResizeObserver(update);
        resizeObserver.observe(el);
    });
    onUnmounted(() => {
        resizeObserver?.disconnect();
    });

    // -- Focus state --

    const focusedIndex = ref<number | null>(null);
    const restoreFocusRef = ref(false);

    // Reset transient state when question changes
    watch(safeIndex, () => {
        setActiveIndex(null);
        focusedIndex.value = null;
    });

    // Restore focus after question change
    watch(safeIndex, () => {
        if (!restoreFocusRef.value) return;
        restoreFocusRef.value = false;
        nextTick(() => {
            const firstRow = rowsContainerRef.value?.querySelector(
                '[data-proximity-index="0"]'
            ) as HTMLElement | null;
            firstRow?.focus();
        });
    });

    function markFocusRestore(): void {
        if (rowsContainerRef.value?.contains(document.activeElement)) {
            restoreFocusRef.value = true;
        }
    }

    // -- Answer actions --

    function goNext(snapshot: Record<string, AskUserAnswer>): void {
        if (safeIndex.value >= total.value - 1) {
            emit('complete', snapshot);
        } else {
            markFocusRestore();
            setIndex(safeIndex.value + 1);
        }
    }

    function handleSingleSelect(optId: string): void {
        if (!question.value) return;
        const optIndex = options.value.findIndex((o, i) => optionKey(o, i) === optId);
        if (optIndex >= 0 && options.value[optIndex]?.disabled) return;
        const text = answers.value[qId.value]?.otherText;
        const snapshot = writeAnswers((prev) => ({
            ...prev,
            [qId.value]: {
                questionId: qId.value,
                selectedIds: [optId],
                otherText: text || undefined,
                skipped: false,
            },
        }));
        goNext(snapshot);
    }

    function handleMultiToggle(optId: string): void {
        if (!question.value) return;
        const optIndex = options.value.findIndex((o, i) => optionKey(o, i) === optId);
        if (optIndex >= 0 && options.value[optIndex]?.disabled) return;
        writeAnswers((prev) => {
            const existing = prev[qId.value];
            const set = new Set(existing?.selectedIds ?? []);
            if (set.has(optId)) set.delete(optId);
            else set.add(optId);
            return {
                ...prev,
                [qId.value]: {
                    questionId: qId.value,
                    selectedIds: Array.from(set),
                    otherText: existing?.otherText,
                    skipped: false,
                },
            };
        });
    }

    function handleOtherChange(text: string): void {
        if (!question.value) return;
        writeAnswers((prev) => ({
            ...prev,
            [qId.value]: {
                questionId: qId.value,
                selectedIds: prev[qId.value]?.selectedIds ?? [],
                otherText: text,
                skipped: false,
            },
        }));
    }

    function handleOtherSubmit(): void {
        if (!question.value) return;
        const text = (answers.value[qId.value]?.otherText ?? '').trim();
        if (!text) return;
        const snapshot = writeAnswers((prev) => ({
            ...prev,
            [qId.value]: {
                questionId: qId.value,
                selectedIds: prev[qId.value]?.selectedIds ?? [],
                otherText: text,
                skipped: false,
            },
        }));
        goNext(snapshot);
    }

    function handleSkip(): void {
        if (!question.value) return;
        const snapshot = writeAnswers((prev) => ({
            ...prev,
            [qId.value]: {
                questionId: qId.value,
                selectedIds: prev[qId.value]?.selectedIds ?? [],
                otherText: prev[qId.value]?.otherText,
                skipped: true,
            },
        }));
        emit('skip', qId.value, safeIndex.value);
        goNext(snapshot);
    }

    function handleMultiNext(): void {
        goNext(answers.value);
    }

    function handleBack(): void {
        if (safeIndex.value > 0) {
            markFocusRestore();
            setIndex(safeIndex.value - 1);
        }
    }

    // -- Keyboard shortcuts: 1-9 --

    function handleNumberKey(e: KeyboardEvent): void {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (!question.value) return;
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
        const code = e.key;
        if (code < '1' || code > '9') return;
        const idx = parseInt(code, 10) - 1;
        if (idx >= 0 && idx < options.value.length) {
            e.preventDefault();
            const opt = options.value[idx];
            if (!opt) return;
            const oid = optionKey(opt, idx);
            if (isMulti.value) handleMultiToggle(oid);
            else handleSingleSelect(oid);
        } else if (idx === options.value.length && allowOther.value) {
            e.preventDefault();
            otherInputRef.value?.focus();
        }
    }

    onMounted(() => {
        document.addEventListener('keydown', handleNumberKey);
        document.addEventListener('keydown', handleNavKey);
    });
    onUnmounted(() => {
        document.removeEventListener('keydown', handleNumberKey);
        document.removeEventListener('keydown', handleNavKey);
    });

    // -- Keyboard navigation (arrow keys, Home/End) --

    function focusRow(idx: number): void {
        const el = rowsContainerRef.value?.querySelector(
            `[data-proximity-index="${idx}"]`
        ) as HTMLElement | null;
        el?.focus();
    }

    function moveActive(next: number): void {
        setActiveIndex(next);
        if (allowOther.value && next === otherIndex.value) {
            otherInputRef.value?.focus();
        } else {
            focusRow(next);
        }
    }

    function handleNavKey(e: KeyboardEvent): void {
        const target = e.target as HTMLElement;
        const isTextInput =
            target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

        if (isTextInput && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;

        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'ArrowLeft') {
                if (safeIndex.value > 0) handleBack();
            } else if (isSkippable.value) {
                handleSkip();
            }
            return;
        }

        if (rowCount.value === 0) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            e.stopPropagation();
            let next: number;
            if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = rowCount.value - 1;
            else {
                const base = isTextInput ? otherIndex.value : (activeIndex.value ?? -1);
                next = e.key === 'ArrowDown' ? base + 1 : base - 1;
                next = (next + rowCount.value) % rowCount.value;
            }
            moveActive(next);
        }
    }

    // -- Cmd/Ctrl+Enter for multi-select continue, Escape for cancel --

    function handleRootKey(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            emit('cancel');
            return;
        }
        if (e.key !== 'Enter') return;
        const mod = e.metaKey || e.ctrlKey;
        if (!mod || !isMulti.value) return;
        e.preventDefault();
        const hasAnswer = selectedIds.value.length > 0 || otherText.value.trim().length > 0;
        if (hasAnswer) handleMultiNext();
    }

    // -- Selected-row grouping (merges contiguous selections) --

    const selectedIndices = computed(() => {
        const set = new Set<number>();
        options.value.forEach((opt, i) => {
            if (selectedIds.value.includes(optionKey(opt, i))) set.add(i);
        });
        if (allowOther.value && otherText.value.length > 0) set.add(otherIndex.value);
        return set;
    });

    // Upstream pattern: stable group IDs require mutable ref update inside computed
    const selectedGroups = computed(() => {
        const runs: { start: number; end: number }[] = [];
        const sorted = [...selectedIndices.value].sort((a, b) => a - b);
        for (const idx of sorted) {
            const last = runs[runs.length - 1];
            if (last && idx === last.end + 1) last.end = idx;
            else runs.push({ start: idx, end: idx });
        }

        const usedIds = new Set<number>();
        const nextGroupMap = new Map<number, number>();
        const groups = runs.map((run) => {
            let stableId: number | null = null;
            for (let i = run.start; i <= run.end; i++) {
                const prev = prevGroupMapRef.value.get(i);
                if (prev !== undefined && !usedIds.has(prev)) {
                    stableId = prev;
                    break;
                }
            }
            const id = stableId ?? ++groupIdCounterRef.value;
            usedIds.add(id);
            for (let i = run.start; i <= run.end; i++) nextGroupMap.set(i, id);
            return { ...run, id };
        });
        prevGroupMapRef.value = nextGroupMap; // eslint-disable-line vue/no-side-effects-in-computed-properties
        return groups;
    });

    // -- Layout computations --

    const activeRect = computed(() =>
        activeIndex.value !== null ? itemRects.value[activeIndex.value] : null
    );
    const isHoveringNonSelected = computed(
        () => activeIndex.value !== null && !selectedIndices.value.has(activeIndex.value)
    );

    const showBack = computed(() => total.value > 1 && safeIndex.value > 0);
    const showSkip = computed(() => isSkippable.value);
    const showFooter = computed(() => showBack.value || showSkip.value || isMulti.value);

    const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform ?? '');
    const modifierSymbol = isMac ? '⌘' : '⌃';

    defineExpose({ rootRef });
</script>
