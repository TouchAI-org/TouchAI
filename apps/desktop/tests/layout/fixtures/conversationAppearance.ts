import '@/styles/tailwind.css';

import { createApp, h, ref } from 'vue';

import StatusDivider from '@/components/ui/status-divider/StatusDivider.vue';
import Toolbar from '@/views/SearchView/components/ConversationPanel/components/ConversationToolbar.vue';
import UserMessage from '@/views/SearchView/components/ConversationPanel/components/UserMessage.vue';

const pinned = ref(false);
const loading = ref(true);
createApp({
    setup: () => () =>
        h('main', [
            h('section', { id: 'toolbar', style: 'position:relative;height:80px' }, [
                h(Toolbar, {
                    isPinned: pinned.value,
                    historyOpen: false,
                    startDragging: async () => {},
                    onPinChange: (value: boolean) => (pinned.value = value),
                }),
            ]),
            h('section', { id: 'message' }, [
                h(UserMessage, {
                    message: {
                        id: 'appearance-user',
                        role: 'user',
                        content: 'Inspect the document',
                        parts: [],
                        timestamp: 1,
                        attachments: [
                            {
                                id: 'appearance-file',
                                type: 'file',
                                name: 'Report.pdf',
                                path: '/fixture/Report.pdf',
                                originPath: '/fixture/Report.pdf',
                            },
                        ],
                    },
                }),
            ]),
            h('section', { id: 'compaction' }, [
                h(StatusDivider, {
                    icon: 'compress',
                    label: loading.value ? 'Compacting context' : 'Context compacted',
                    loading: loading.value,
                }),
            ]),
            h('button', { id: 'complete', onClick: () => (loading.value = false) }, 'Complete'),
        ]),
}).mount('#app');
