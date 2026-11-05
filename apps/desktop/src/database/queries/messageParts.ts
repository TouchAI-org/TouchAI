// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { MessagePartEntity } from '../types';

/** Derive plain text only at consumers that need it; parts remain the source of truth. */
export function getMessageText(parts: readonly MessagePartEntity[]): string {
    return parts
        .filter((part) => part.type === 'text')
        .map((part) => part.content)
        .join('');
}
