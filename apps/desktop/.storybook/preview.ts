/**
 * Storybook preview setup.
 *
 * Two things matter for visual tests here:
 *
 * 1. The app's stylesheet is imported so stories resolve the real tokens. A story
 *    rendered without it would pass while the product drifts.
 * 2. The canvas uses the app's own surface colour, set in `preview-head.html`,
 *    because Storybook defaults to white and a card designed for a warm
 *    off-white page would otherwise be compared against the wrong backdrop.
 */
import '@styles/tailwind.css';

import type { Preview } from '@storybook/vue3-vite';

const preview: Preview = {
    parameters: {
        controls: { expanded: false },
        // Stories are sized by their own markup; Playwright pins the viewport per
        // screenshot so a baseline records one exact size.
        layout: 'fullscreen',
    },
    decorators: [
        () => ({
            template: '<div class="font-serif text-compact text-text-primary"><story /></div>',
        }),
    ],
};

export default preview;
