// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import type { MessageEntity, MessagePartEntity } from '../types';
import type { MessageAttachmentRow } from './attachments';

/** A database message is returned once, with its ordered parts and resolved attachments. */
export interface MessageRow extends MessageEntity {
    parts: MessagePartEntity[];
    attachments: MessageAttachmentRow[];
}

export const countMessages = async (): Promise<number> =>
    native.database.operation<number>({ kind: 'message_count' });

export const deleteAllMessages = async (): Promise<void> => {
    await native.database.operation({ kind: 'message_delete_all' });
};
