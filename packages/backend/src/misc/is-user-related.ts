/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiUser } from '@/models/_.js';

interface NoteLike {
	userId: MiUser['id'];
	reply?: NoteLike | null;
	renote?: NoteLike | null;
	replyUserId?: MiUser['id'] | null;
	renoteUserId?: MiUser['id'] | null;
	anonymouslySendToUserId?: MiUser['id'] | null;
	anonymousChannelUsername?: string | null;
}

function isNoteAuthorRelated(note: NoteLike, userIds: Set<string>): boolean {
	return !note.anonymousChannelUsername && !note.anonymouslySendToUserId && userIds.has(note.userId);
}

export function isUserRelated(note: NoteLike | null | undefined, userIds: Set<string>, ignoreAuthor = false): boolean {
	if (!note) {
		return false;
	}

	if (!ignoreAuthor && isNoteAuthorRelated(note, userIds)) {
		return true;
	}

	const replyUserId = note.replyUserId ?? note.reply?.userId;
	if (replyUserId != null && replyUserId !== note.userId && note.reply && isNoteAuthorRelated(note.reply, userIds)) {
		return true;
	}

	const renoteUserId = note.renoteUserId ?? note.renote?.userId;
	if (renoteUserId != null && renoteUserId !== note.userId && note.renote && isNoteAuthorRelated(note.renote, userIds)) {
		return true;
	}

	return false;
}

