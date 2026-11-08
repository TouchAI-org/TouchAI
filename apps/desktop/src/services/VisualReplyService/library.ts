// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    type ComponentRenderProps,
    createLibrary,
    createParser,
    defineComponent,
} from '@openuidev/vue-lang';
import { h } from 'vue';
import { z } from 'zod';

import DonutChart from '@/components/ui/donut-chart/DonutChart.vue';

import { dispatchVisualReplyLink, dispatchVisualReplyPrompt } from './bridge';

type AnyProps = Record<string, unknown>;
type RenderProps = ComponentRenderProps<AnyProps>;

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
    render: (props: AnyProps, renderNode: RenderProps['renderNode']) => unknown
) {
    return defineComponent({
        name,
        description,
        props,
        component: {
            props: ['props', 'renderNode'],
            setup({ props: values, renderNode }: RenderProps) {
                return () => render(values, renderNode);
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
    'A compact section heading.',
    z.object({ text: z.string(), level: z.number().optional() }),
    (props) => {
        const level = Math.min(4, Math.max(2, Number(props.level ?? 2)));
        return h(`h${level}`, { class: 'visual-reply-heading' }, textValue(props.text));
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

const Grid = defineNode(
    'Grid',
    'A responsive two or three column layout of label and value pairs.',
    z.object({
        items: z.array(z.object({ label: z.string(), value: z.string() })),
        columns: z.enum(['2', '3']).optional(),
    }),
    (props) =>
        h(
            'div',
            { class: `visual-reply-grid visual-reply-grid-${props.columns ?? '2'}` },
            (props.items as Array<{ label: string; value: string }>).map((item) =>
                h('div', { class: 'visual-reply-metric' }, [
                    h('span', { class: 'visual-reply-muted' }, item.label),
                    h('strong', { class: 'visual-reply-metric-value' }, item.value),
                ])
            )
        )
);

const Card = defineNode(
    'Card',
    'A compact bordered surface for related information. Keep cards individual, not nested.',
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
    'A label, prominent value, and optional supporting detail.',
    z.object({
        label: z.string(),
        value: z.string(),
        detail: z.string().optional(),
        tone: z.enum(['neutral', 'info', 'success', 'warning', 'danger']).optional(),
    }),
    (props) =>
        h('div', { class: 'visual-reply-metric' }, [
            h('span', { class: 'visual-reply-muted' }, textValue(props.label)),
            h(
                'strong',
                { class: `visual-reply-metric-value visual-reply-tone-${tone(props.tone)}` },
                textValue(props.value)
            ),
            props.detail
                ? h('span', { class: 'visual-reply-muted' }, textValue(props.detail))
                : null,
        ])
);

const DataTable = defineNode(
    'DataTable',
    'A compact semantic table. Provide column names and rows of text values.',
    z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.string())) }),
    (props) =>
        h('div', { class: 'visual-reply-table-wrap' }, [
            h('table', { class: 'visual-reply-table' }, [
                h(
                    'thead',
                    h(
                        'tr',
                        (props.columns as string[]).map((column) => h('th', column))
                    )
                ),
                h(
                    'tbody',
                    (props.rows as string[][]).map((row) =>
                        h(
                            'tr',
                            row.map((cell: string) => h('td', textValue(cell)))
                        )
                    )
                ),
            ]),
        ])
);

const BarChart = defineNode(
    'BarChart',
    'A responsive interactive bar chart. Values and labels must have matching lengths.',
    z.object({ label: z.string(), values: z.array(z.number()), labels: z.array(z.string()) }),
    (props) => {
        const values = (props.values as number[]).slice(0, 24).map((value) => Math.max(0, value));
        const labels = (props.labels as string[]).slice(0, values.length);
        const maximum = Math.max(1, ...values);
        const barWidth = 100 / Math.max(1, values.length);
        return h('figure', { class: 'visual-reply-chart' }, [
            h('figcaption', { class: 'visual-reply-muted' }, textValue(props.label)),
            h(
                'svg',
                { viewBox: `0 0 600 190`, role: 'img', 'aria-label': textValue(props.label) },
                [
                    h('line', { x1: 0, y1: 160, x2: 600, y2: 160, class: 'visual-reply-axis' }),
                    ...values.map((value, index) => {
                        const height = (value / maximum) * 126;
                        const x = index * barWidth * 6 + 8;
                        const width = Math.max(5, barWidth * 6 - 12);
                        return h('g', { key: `${index}-${value}` }, [
                            h('rect', {
                                x,
                                y: 158 - height,
                                width,
                                height,
                                rx: 3,
                                class: 'visual-reply-bar',
                            }),
                            h(
                                'text',
                                {
                                    x: x + width / 2,
                                    y: 178,
                                    'text-anchor': 'middle',
                                    class: 'visual-reply-chart-label',
                                },
                                labels[index] ?? String(index + 1)
                            ),
                            h('title', `${labels[index] ?? index + 1}: ${value}`),
                        ]);
                    }),
                ]
            ),
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
    (props) =>
        h(
            'button',
            {
                type: 'button',
                class: `visual-reply-button visual-reply-button-${props.variant ?? 'secondary'}`,
                onClick: () => dispatchVisualReplyPrompt(props.prompt ?? props.label),
            },
            textValue(props.label)
        )
);

const LinkButton = defineNode(
    'LinkButton',
    'A button that opens an HTTP or HTTPS URL in the host.',
    z.object({ label: z.string(), url: z.string() }),
    (props) =>
        h(
            'button',
            {
                type: 'button',
                class: 'visual-reply-link',
                onClick: () => dispatchVisualReplyLink(props.url),
            },
            textValue(props.label)
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
        Text,
        Heading,
        Card,
        Badge,
        Alert,
        Metric,
        DataTable,
        BarChart,
        Donut,
        ActionButton,
        LinkButton,
    ],
    componentGroups: [
        { name: 'Layout', components: ['Root', 'Stack', 'Grid'] },
        {
            name: 'Content',
            components: ['Text', 'Heading', 'Card', 'Badge', 'Alert', 'Metric', 'DataTable'],
        },
        { name: 'Visualization', components: ['BarChart', 'DonutChart'] },
        { name: 'Actions', components: ['ActionButton', 'LinkButton'] },
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
