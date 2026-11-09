// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    type ComponentRenderProps,
    createLibrary,
    createParser,
    defineComponent,
    useIsStreaming,
} from '@openuidev/vue-lang';
import { h, type Ref } from 'vue';
import { z } from 'zod';

import BarChartPrimitive from '@/components/ui/bar-chart/BarChart.vue';
import DonutChart from '@/components/ui/donut-chart/DonutChart.vue';

import { dispatchVisualReplyLink, dispatchVisualReplyPrompt } from './bridge';

type AnyProps = Record<string, unknown>;
type RenderProps = ComponentRenderProps<AnyProps>;
type StreamingState = Ref<boolean>;

function textValue(value: unknown): string {
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function tone(value: unknown): string {
    return ['info', 'success', 'warning', 'danger'].includes(String(value))
        ? String(value)
        : 'neutral';
}

function defineNode(
    name: string,
    description: string,
    props: z.ZodObject,
    render: (
        props: AnyProps,
        renderNode: RenderProps['renderNode'],
        isStreaming: StreamingState
    ) => unknown
) {
    return defineComponent({
        name,
        description,
        props,
        component: {
            props: ['props', 'renderNode'],
            setup({ props: values, renderNode }: RenderProps) {
                const isStreaming = useIsStreaming();
                return () => render(values, renderNode, isStreaming);
            },
        },
    });
}

const Text = defineNode(
    'Text',
    'A short prose block. Use tone body, muted, lead, or code.',
    z.object({ text: z.string(), tone: z.enum(['body', 'muted', 'lead', 'code']).optional() }),
    (props) =>
        h(
            'p',
            { class: `visual-reply-text visual-reply-text-${props.tone ?? 'body'}` },
            textValue(props.text)
        )
);

const Heading = defineNode(
    'Heading',
    'A section heading. Level 2 is the reply title; level 3 starts a new section.',
    z.object({ text: z.string(), level: z.number().optional() }),
    (props) => {
        const level = Math.min(4, Math.max(2, Number(props.level ?? 2)));
        return h(
            `h${level}`,
            { class: 'visual-reply-heading', 'data-level': String(level) },
            textValue(props.text)
        );
    }
);

const Stack = defineNode(
    'Stack',
    'A vertical layout for a list of short text values.',
    z.object({ items: z.array(z.string()), gap: z.enum(['sm', 'md', 'lg']).optional() }),
    (props) =>
        h(
            'div',
            { class: `visual-reply-stack visual-reply-gap-${props.gap ?? 'md'}` },
            (props.items as string[]).map((item) => h('p', { class: 'visual-reply-text' }, item))
        )
);

const Card = defineNode(
    'Card',
    'A section for related information. Keep cards individual, not nested.',
    z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        body: z.string().optional(),
    }),
    (props) =>
        h('section', { class: 'visual-reply-card' }, [
            props.title
                ? h('h3', { class: 'visual-reply-card-title' }, textValue(props.title))
                : null,
            props.description
                ? h('p', { class: 'visual-reply-muted' }, textValue(props.description))
                : null,
            props.body ? h('p', { class: 'visual-reply-text' }, textValue(props.body)) : null,
        ])
);

const Badge = defineNode(
    'Badge',
    'A small semantic status label.',
    z.object({
        text: z.string(),
        tone: z.enum(['neutral', 'info', 'success', 'warning', 'danger']).optional(),
    }),
    (props) =>
        h(
            'span',
            { class: `visual-reply-badge visual-reply-tone-${tone(props.tone)}` },
            textValue(props.text)
        )
);

const Alert = defineNode(
    'Alert',
    'A concise callout with a semantic tone.',
    z.object({
        title: z.string(),
        description: z.string().optional(),
        tone: z.enum(['info', 'success', 'warning', 'danger']).optional(),
    }),
    (props) =>
        h('aside', { class: `visual-reply-alert visual-reply-tone-${tone(props.tone)}` }, [
            h('strong', textValue(props.title)),
            props.description ? h('span', textValue(props.description)) : null,
        ])
);

const Metric = defineNode(
    'Metric',
    'A key figure: large value first, then a muted label and optional detail.',
    z.object({
        label: z.string(),
        value: z.string(),
        detail: z.string().optional(),
        tone: z.enum(['neutral', 'info', 'success', 'warning', 'danger']).optional(),
    }),
    (props) =>
        h('div', { class: 'visual-reply-metric' }, [
            h(
                'strong',
                {
                    class:
                        props.tone && tone(props.tone) !== 'neutral'
                            ? `visual-reply-metric-value visual-reply-tone-${tone(props.tone)}`
                            : 'visual-reply-metric-value',
                },
                textValue(props.value)
            ),
            h('span', { class: 'visual-reply-metric-label' }, textValue(props.label)),
            props.detail
                ? h('span', { class: 'visual-reply-metric-detail' }, textValue(props.detail))
                : null,
        ])
);

const Grid = defineNode(
    'Grid',
    'A rule-separated strip of Metric components. Use it for grouped key figures.',
    z.object({
        items: z.array(Metric.ref),
        columns: z.enum(['2', '3', '4']).optional(),
    }),
    (props, renderNode) =>
        h(
            'div',
            { class: `visual-reply-grid visual-reply-grid-${props.columns ?? '2'}` },
            (props.items as NodeValue[]).map(renderNode) as never
        )
);

const DataTable = defineNode(
    'DataTable',
    'A compact semantic table. Provide column names and rows of text values.',
    z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.string())) }),
    (props) => {
        const rows = (props.rows as string[][]).map((row) => row.map(textValue));
        const numericColumns = (props.columns as string[]).map((_, index) => {
            const cells = rows.map((row) => row[index] ?? '');
            return (
                cells.length > 0 &&
                cells.every((cell) => /^[+-]?[$€¥]?[\d,.]+%?$/.test(cell.trim()))
            );
        });

        return h('div', { class: 'visual-reply-table-wrap' }, [
            h('table', { class: 'visual-reply-table' }, [
                h(
                    'thead',
                    h(
                        'tr',
                        (props.columns as string[]).map((column, index) =>
                            h(
                                'th',
                                { class: numericColumns[index] ? 'visual-reply-num' : '' },
                                column
                            )
                        )
                    )
                ),
                h(
                    'tbody',
                    rows.map((row) =>
                        h(
                            'tr',
                            row.map((cell, index) =>
                                h(
                                    'td',
                                    { class: numericColumns[index] ? 'visual-reply-num' : '' },
                                    cell
                                )
                            )
                        )
                    )
                ),
            ]),
        ]);
    }
);

const BarChart = defineNode(
    'BarChart',
    'A responsive interactive bar chart. Values and labels must have matching lengths.',
    z.object({ label: z.string(), values: z.array(z.number()), labels: z.array(z.string()) }),
    (props) => {
        const label = textValue(props.label);
        const values = (props.values as number[]).slice(0, 24).map((value) => Math.max(0, value));
        const labels = (props.labels as string[]).slice(0, values.length);
        return h('section', { class: 'visual-reply-chart-block' }, [
            label ? h('p', { class: 'visual-reply-chart-title' }, label) : null,
            h(BarChartPrimitive, {
                class: 'visual-reply-chart',
                label,
                data: values.map((value, index) => ({
                    key: String(index),
                    label: labels[index] ?? String(index + 1),
                    values: { value },
                })),
                series: [
                    {
                        key: 'value',
                        label: label || 'Values',
                        color: 'var(--color-primary-500)',
                    },
                ],
                height: 208,
                legend: false,
                showAverage: false,
                formatValue: (value: number) =>
                    Number.isInteger(value) ? String(value) : value.toFixed(1),
            }),
        ]);
    }
);

const Donut = defineNode(
    'DonutChart',
    'An interactive ring chart with a legend. Values and labels must have matching lengths.',
    z.object({
        labels: z.array(z.string()),
        values: z.array(z.number()),
        totalLabel: z.string().optional(),
    }),
    (props) =>
        h(DonutChart, {
            data: (props.values as number[]).slice(0, 8).map((value, index) => ({
                key: String(index),
                label: (props.labels as string[])[index] ?? String(index + 1),
                value: Math.max(0, value),
            })),
            totalLabel: textValue(props.totalLabel) || 'Total',
            size: 180,
        })
);

const ActionButton = defineNode(
    'ActionButton',
    'A button that continues the conversation with a suggested prompt.',
    z.object({
        label: z.string(),
        prompt: z.string().optional(),
        variant: z.enum(['primary', 'secondary']).optional(),
    }),
    (props, _renderNode, isStreaming) =>
        h(
            'button',
            {
                type: 'button',
                disabled: isStreaming.value,
                class: `visual-reply-button visual-reply-button-${props.variant ?? 'secondary'}`,
                onClick: () => {
                    if (!isStreaming.value) {
                        dispatchVisualReplyPrompt(props.prompt ?? props.label);
                    }
                },
            },
            textValue(props.label)
        )
);

const LinkButton = defineNode(
    'LinkButton',
    'A button that opens an HTTP or HTTPS URL in the host.',
    z.object({ label: z.string(), url: z.string() }),
    (props, _renderNode, isStreaming) =>
        h(
            'button',
            {
                type: 'button',
                disabled: isStreaming.value,
                class: 'visual-reply-link',
                onClick: () => {
                    if (!isStreaming.value) dispatchVisualReplyLink(props.url);
                },
            },
            textValue(props.label)
        )
);

const Actions = defineNode(
    'Actions',
    'An optional row that groups ActionButton and LinkButton controls.',
    z.object({ content: z.array(z.union([ActionButton.ref, LinkButton.ref])) }),
    (props, renderNode) =>
        h(
            'div',
            { class: 'visual-reply-actions' },
            (props.content as NodeValue[]).map(renderNode) as never
        )
);

const NodeValueSchema = z.union([
    Text.ref,
    Heading.ref,
    Stack.ref,
    Grid.ref,
    Card.ref,
    Badge.ref,
    Alert.ref,
    Metric.ref,
    DataTable.ref,
    BarChart.ref,
    Donut.ref,
    Actions.ref,
    ActionButton.ref,
    LinkButton.ref,
]);

const Root = defineNode(
    'Root',
    'The required root container for every OpenUI reply. It accepts a list of registered components.',
    z.object({
        content: z.array(NodeValueSchema),
    }),
    (props, renderNode) =>
        h(
            'div',
            { class: 'visual-reply-root' },
            (props.content as NodeValue[]).map(renderNode) as never
        )
);

export const visualReplyLibrary = createLibrary({
    root: 'Root',
    components: [
        Root,
        Stack,
        Grid,
        Metric,
        Text,
        Heading,
        Card,
        Badge,
        Alert,
        DataTable,
        BarChart,
        Donut,
        Actions,
        ActionButton,
        LinkButton,
    ],
    componentGroups: [
        { name: 'Layout', components: ['Root', 'Stack', 'Grid', 'Metric'] },
        {
            name: 'Content',
            components: ['Text', 'Heading', 'Card', 'Badge', 'Alert', 'DataTable'],
        },
        { name: 'Visualization', components: ['BarChart', 'DonutChart'] },
        { name: 'Actions', components: ['Actions', 'ActionButton', 'LinkButton'] },
    ],
});

export const visualReplyParser = createParser(visualReplyLibrary.toJSONSchema(), 'Root');

export const visualReplySystemPrompt = visualReplyLibrary.prompt({
    preamble:
        'Generate useful visual replies using only the registered components. Keep output concise, accessible, and data-led.',
    inlineMode: true,
    toolCalls: false,
    bindings: false,
    additionalRules: [
        'Use openui-lang code fences only when the user asks for a visual, diagram, chart, interactive explanation, or a structured view. Answer ordinary questions in plain text.',
        'Use positional arguments, not named arguments: root = Root([Heading("Quarterly revenue", 2), BarChart("Revenue", [42, 58], ["Q1", "Q2"])]) is valid.',
        'Root, Stack, and Grid take arrays of registered component calls. Define root as the first statement and use only documented components.',
        'Use touchai-artifact code fences only when the user explicitly needs free-form HTML, SVG, animation, or algorithm interaction that the fixed component set cannot express. Artifact scripts are inert until streaming finishes and run in a sandboxed iframe. Network requests and external anchor navigation are blocked, but child-frame self-navigation is not guaranteed to be blocked on every WebView. Artifacts have no host action bridge. Use OpenUI ActionButton or LinkButton for user-approved conversation and link actions.',
        'Do not add prose around an openui-lang block when the user asks only for a visual. Put labels, values, and actions in components.',
    ],
});

type NodeValue = unknown;
