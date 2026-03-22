import type { Component } from 'vue';

import IconBrain from '~icons/bx/brain';
import IconBriefcase from '~icons/bx/briefcase-alt-2';
import IconCheckCircle from '~icons/bx/check-circle';
import IconChevronDown from '~icons/bx/chevron-down';
import IconChevronRight from '~icons/bx/chevron-right';
import IconChevronUp from '~icons/bx/chevron-up';
import IconCog from '~icons/bx/cog';
import IconCopy from '~icons/bx/copy';
import IconData from '~icons/bx/data';
import IconArrowDown from '~icons/bx/down-arrow-alt';
import IconEdit from '~icons/bx/edit-alt';
import IconError from '~icons/bx/error';
import IconFile from '~icons/bx/file';
import IconFileBlank from '~icons/bx/file-blank';
import IconHide from '~icons/bx/hide';
import IconHistory from '~icons/bx/history';
import IconInfoCircle from '~icons/bx/info-circle';
import IconMinus from '~icons/bx/minus';
import IconPin from '~icons/bx/pin';
import IconPlay from '~icons/bx/play';
import IconPlug from '~icons/bx/plug';
import IconPlus from '~icons/bx/plus';
import IconRefresh from '~icons/bx/refresh';
import IconSearch from '~icons/bx/search';
import IconShow from '~icons/bx/show';
import IconStop from '~icons/bx/stop';
import IconTrash from '~icons/bx/trash';
import IconTrashAlt from '~icons/bx/trash-alt';
import IconWrench from '~icons/bx/wrench';
import IconX from '~icons/bx/x';
import IconXCircle from '~icons/bx/x-circle';

export const appIconMap = {
    'arrow-down': IconArrowDown,
    'check-circle': IconCheckCircle,
    'chevron-down': IconChevronDown,
    'chevron-right': IconChevronRight,
    'chevron-up': IconChevronUp,
    close: IconX,
    copy: IconCopy,
    database: IconData,
    delete: IconTrashAlt,
    'document-text': IconFileBlank,
    edit: IconEdit,
    'exclamation-triangle': IconError,
    eye: IconShow,
    'eye-off': IconHide,
    file: IconFile,
    history: IconHistory,
    'information-circle': IconInfoCircle,
    llm: IconBrain,
    mcp: IconPlug,
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
    wrench: IconWrench,
    x: IconX,
    'x-circle': IconXCircle,
} satisfies Record<string, Component>;

export const appIconFallback = IconInfoCircle;

export type AppIconName = keyof typeof appIconMap;
