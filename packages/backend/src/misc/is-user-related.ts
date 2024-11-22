/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Note } from 'misskey-js/entities.js';

function isNoteAuthorRelated(note: Partial<Note>, userIds: Set<string>): boolean {
	return !note.anonymousChannelUsername && !note.anonymouslySendToUserId && note.userId != null && userIds.has(note.userId);
}

export function isUserRelated(note: any, userIds: Set<string>, ignoreAuthor = false): boolean {
	return !!note && (
		!ignoreAuthor && isNoteAuthorRelated(note, userIds)
		|| note.reply != null && isNoteAuthorRelated(note.reply, userIds)
		|| note.renote != null && isNoteAuthorRelated(note.renote, userIds)
	);
}
