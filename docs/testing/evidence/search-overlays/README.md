# Search window layout evidence

These browser fixtures use the production search layout, conversation components,
motion styles, and geometry owner. Native IPC, the editor, and unrelated message
renderers are isolated. They are not full desktop screenshots or evidence of native
click-through, monitor/DPI handling, or release performance.

The runner is documented in
[the layout regression guide](../../../../apps/desktop/tests/layout/README.md).
It covers 420px and 750px widths with normal and reduced motion.

## Keyboard focus

After Enter, the conversation receives focus so keyboard scrolling remains available.
The earlier viewport style painted a 2px inset ring around the entire conversation.
The updated style removes that ring; individual navigation buttons keep their focus
indicators. The browser regression checks the actual computed shadow and outline,
and verifies that focus remains on the scroll viewport.

| Before, 420px | After, 420px |
| --- | --- |
| ![Conversation with a focus ring](conversation-focus-before-420.png) | ![Conversation without the container focus ring](conversation-focus-after-420.png) |

## Cancellation height

The pending and cancelled states retain the same card height. The editor in these
fixtures is the fixed-height test row labeled `Input`.

| Pending, 750px | Cancelled, 750px |
| --- | --- |
| ![Pending conversation](conversation-loading-750.png) | ![Cancelled conversation](conversation-cancelled-750.png) |
