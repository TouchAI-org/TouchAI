// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { BuiltInToolGroup } from '../../types';
import { showWidgetTool } from './showWidget';

export { showWidgetTool } from './showWidget';
export { SHOW_WIDGET_STYLE_GUIDELINES } from './showWidget/constants';
export {
    buildShowWidgetDraftFromArgumentsBuffer,
    createShowWidgetBaseStyles,
    createWidgetRenderer,
    isShowWidgetResourceUrlAllowed,
    SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS,
    SHOW_WIDGET_TOOL_NAME,
    type ShowWidgetPayload,
    type WidgetRenderer,
} from './showWidget/runtime';
export const builtInTools: BuiltInToolGroup = [showWidgetTool];
