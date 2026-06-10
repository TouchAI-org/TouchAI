import type { Component } from 'vue';

import IconArrowDown from '~icons/lucide/arrow-down';
import IconArrowLeft from '~icons/lucide/arrow-left';
import IconArrowRight from '~icons/lucide/arrow-right';
import IconBlocks from '~icons/lucide/blocks';
import IconBoxes from '~icons/lucide/boxes';
import IconBriefcase from '~icons/lucide/briefcase';
import IconBug from '~icons/lucide/bug';
import IconChevronDown from '~icons/lucide/chevron-down';
import IconChevronRight from '~icons/lucide/chevron-right';
import IconChevronUp from '~icons/lucide/chevron-up';
import IconCheckCircle from '~icons/lucide/circle-check';
import IconXCircle from '~icons/lucide/circle-x';
import IconCopy from '~icons/lucide/copy';
import IconData from '~icons/lucide/database';
import IconLinkExternal from '~icons/lucide/external-link';
import IconShow from '~icons/lucide/eye';
import IconHide from '~icons/lucide/eye-off';
import IconFile from '~icons/lucide/file';
import IconFileBlank from '~icons/lucide/file-text';
import IconFolderOpen from '~icons/lucide/folder-open';
import IconGithub from '~icons/lucide/github';
import IconGlobe from '~icons/lucide/globe';
import IconGridAlt from '~icons/lucide/grid-2x2';
import IconHistory from '~icons/lucide/history';
import IconInfoCircle from '~icons/lucide/info';
import IconLeaf from '~icons/lucide/leaf';
import IconMaximize from '~icons/lucide/maximize';
import IconMenu from '~icons/lucide/menu';
import IconChatHistory from '~icons/lucide/message-circle-more';
import IconWindowRestore from '~icons/lucide/minimize';
import IconMinus from '~icons/lucide/minus';
import IconEdit from '~icons/lucide/pencil';
import IconPin from '~icons/lucide/pin';
import IconPlay from '~icons/lucide/play';
import IconPlus from '~icons/lucide/plus';
import IconRefresh from '~icons/lucide/refresh-cw';
import IconSearch from '~icons/lucide/search';
import IconCog from '~icons/lucide/settings';
import IconStop from '~icons/lucide/square';
import IconTrash from '~icons/lucide/trash-2';
import IconError from '~icons/lucide/triangle-alert';
import IconWrench from '~icons/lucide/wrench';
import IconX from '~icons/lucide/x';

export const appIconMap = {
    'arrow-down': IconArrowDown,
    'arrow-left': IconArrowLeft,
    'arrow-right': IconArrowRight,
    'check-circle': IconCheckCircle,
    'chevron-down': IconChevronDown,
    'chevron-right': IconChevronRight,
    'chevron-up': IconChevronUp,
    close: IconX,
    copy: IconCopy,
    database: IconData,
    delete: IconTrash,
    'document-text': IconFileBlank,
    edit: IconEdit,
    'exclamation-triangle': IconError,
    eye: IconShow,
    'eye-off': IconHide,
    file: IconFile,
    folder: IconFolderOpen,
    'folder-open': IconFolderOpen,
    fullscreen: IconStop,
    github: IconGithub,
    'grid-alt': IconGridAlt,
    globe: IconGlobe,
    history: IconHistory,
    'list-ul': IconMenu,
    'chat-history': IconChatHistory,
    maximize: IconMaximize,
    restore: IconWindowRestore,
    'information-circle': IconInfoCircle,
    llm: IconBoxes,
    leaf: IconLeaf,
    'external-link': IconLinkExternal,
    mcp: IconBlocks,
    minimize: IconMinus,
    pin: IconPin,
    play: IconPlay,
    plus: IconPlus,
    refresh: IconRefresh,
    search: IconSearch,
    settings: IconCog,
    stop: IconStop,
    tool: IconBriefcase,
    trash: IconTrash,
    bug: IconBug,
    wrench: IconWrench,
    x: IconX,
    'x-circle': IconXCircle,
    'exit-fullscreen': IconCopy,
} satisfies Record<string, Component>;

export const appIconFallback = IconInfoCircle;

export type AppIconName = keyof typeof appIconMap;
