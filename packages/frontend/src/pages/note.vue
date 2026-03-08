<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :actions="headerActions" :tabs="headerTabs">
	<div class="_spacer" style="--MI_SPACER-w: 800px;">
		<Transition :name="prefer.s.animation ? 'fade' : ''" mode="out-in">
			<div v-if="note">
				<div v-if="showNext" class="_margin">
					<MkNotesTimeline direction="up" :withControl="false" :pullToRefresh="false" class="" :paginator="nextPaginator" :noGap="true" :forceDisableInfiniteScroll="true" />
				</div>

				<div class="_margin">
					<div v-if="!showNext" class="_buttons" :class="$style.loadNext">
						<MkButton v-if="note.channelId" rounded :class="$style.loadButton" @click="showNext = 'channel'"><i class="ti ti-chevron-up"></i> <i class="ti ti-device-tv"></i></MkButton>
						<template v-else-if="note.visibility === 'public'">
							<MkButton v-if="prefer.s.localNeighborNotes" rounded :class="$style.loadButton" @click="showNext = 'local'"><i class="ti ti-chevron-up"></i> <i class="ti ti-planet"></i></MkButton>
							<MkButton v-if="prefer.s.globalNeighborNotes" rounded :class="$style.loadButton" @click="showNext = 'global'"><i class="ti ti-chevron-up"></i> <i class="ti ti-whirl"></i></MkButton>
						</template>
						<MkButton rounded :class="$style.loadButton" @click="showNext = 'user'"><i class="ti ti-chevron-up"></i> <i class="ti ti-user"></i></MkButton>
					</div>
					<div class="_margin _gaps_s">
						<MkRemoteCaution v-if="note.user.host != null" :href="note.url ?? note.uri"/>
						<MkNoteDetailed :key="note.id" v-model:note="note" :initialTab="initialTab" :class="$style.note"/>
					</div>
					<div v-if="clips && clips.length > 0" class="_margin">
						<div style="font-weight: bold; padding: 12px;">{{ i18n.ts.clip }}</div>
						<div class="_gaps">
							<MkClipPreview v-for="item in clips" :key="item.id" :clip="item"/>
						</div>
					</div>
					<div v-if="!showPrev" class="_buttons" :class="$style.loadPrev">
						<MkButton v-if="note.channelId" rounded :class="$style.loadButton" @click="showPrev = 'channel'"><i class="ti ti-chevron-down"></i> <i class="ti ti-device-tv"></i></MkButton>
						<template v-else-if="note.visibility === 'public'">
							<MkButton v-if="prefer.s.localNeighborNotes" rounded :class="$style.loadButton" @click="showPrev = 'local'"><i class="ti ti-chevron-down"></i> <i class="ti ti-planet"></i></MkButton>
							<MkButton v-if="prefer.s.globalNeighborNotes" rounded :class="$style.loadButton" @click="showPrev = 'global'"><i class="ti ti-chevron-down"></i> <i class="ti ti-whirl"></i></MkButton>
						</template>
						<MkButton rounded :class="$style.loadButton" @click="showPrev = 'user'"><i class="ti ti-chevron-down"></i> <i class="ti ti-user"></i></MkButton>
					</div>
				</div>

				<div v-if="showPrev" class="_margin">
					<MkNotesTimeline :withControl="false" :pullToRefresh="false" class="" :paginator="prevPaginator" :noGap="true"/>
				</div>
			</div>
			<MkError v-else-if="error" @retry="fetchNote()"/>
			<MkLoading v-else/>
		</Transition>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, watch, ref, markRaw } from 'vue';
import * as Misskey from 'misskey-js';
import { host, hostname } from '@@/js/config.js';
import MkNoteDetailed from '@/components/MkNoteDetailed.vue';
import MkNotesTimeline from '@/components/MkNotesTimeline.vue';
import MkRemoteCaution from '@/components/MkRemoteCaution.vue';
import MkButton from '@/components/MkButton.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { definePage } from '@/page.js';
import { i18n } from '@/i18n.js';
import { dateString } from '@/filters/date.js';
import MkClipPreview from '@/components/MkClipPreview.vue';
import { prefer } from '@/preferences.js';
import { pleaseLogin } from '@/utility/please-login.js';
import { getAppearNote } from '@/utility/get-appear-note.js';
import { serverContext, assertServerContext } from '@/server-context.js';
import { $i } from '@/i.js';
import { Paginator } from '@/utility/paginator.js';

// contextは非ログイン状態の情報しかないためログイン時は利用できない
const CTX_NOTE = !$i && assertServerContext(serverContext, 'note') ? serverContext.note : null;

const props = defineProps<{
	noteId: string;
	initialTab?: string;
}>();

function userOf(note: Misskey.entities.Note): Misskey.entities.User {
	return note.anonymousChannelUsername ? { ...note.user, username: note.anonymousChannelUsername, avatarUrl: `${location.origin}/identicon/@${note.anonymousChannelUsername}@${hostname}` } : note.user;
}

const note = ref<null | Misskey.entities.Note>(CTX_NOTE);
const clips = ref<Misskey.entities.Clip[]>();
const showPrev = ref<'user' | 'global' | 'local' | 'channel' | false>(false);
const showNext = ref<'user' | 'global' | 'local' | 'channel' | false>(false);
const prevPaginator = computed(() => {
	switch (showPrev.value) {
		case 'channel': return prevChannelPaginator;
		case 'local': return prevLocalPaginator;
		case 'global': return prevGlobalPaginator;
		case 'user': return prevUserPaginator;
		default: return undefined as never;
	}
});
const nextPaginator = computed(() => {
	switch (showNext.value) {
		case 'channel': return nextChannelPaginator;
		case 'local': return nextLocalPaginator;
		case 'global': return nextGlobalPaginator;
		case 'user': return nextUserPaginator;
		default: return undefined as never;
	}
});
const error = ref();

const prevUserPaginator = markRaw(new Paginator('users/notes', {
	limit: 10,
	initialId: props.noteId,
	computedParams: computed(() => note.value ? ({
		userId: note.value.userId,
	}) : undefined),
}));

const nextUserPaginator = markRaw(new Paginator('users/notes', {
	limit: 10,
	initialId: props.noteId,
	initialDirection: 'newer',
	computedParams: computed(() => note.value ? ({
		userId: note.value.userId,
	}) : undefined),
}));

const prevGlobalPaginator = markRaw(new Paginator('notes/global-timeline', {
	limit: 10,
	initialId: props.noteId,
}));

const nextGlobalPaginator = markRaw(new Paginator('notes/global-timeline', {
	limit: 10,
	initialId: props.noteId,
	initialDirection: 'newer',
}));

const prevLocalPaginator = markRaw(new Paginator('notes/local-timeline', {
	limit: 10,
	initialId: props.noteId,
}));

const nextLocalPaginator = markRaw(new Paginator('notes/local-timeline', {
	limit: 10,
	initialId: props.noteId,
	initialDirection: 'newer',
}));

const prevChannelPaginator = markRaw(new Paginator('channels/timeline', {
	limit: 10,
	initialId: props.noteId,
	computedParams: computed(() => note.value && note.value.channelId != null ? ({
		channelId: note.value.channelId,
	}) : undefined),
}));

const nextChannelPaginator = markRaw(new Paginator('channels/timeline', {
	limit: 10,
	initialId: props.noteId,
	initialDirection: 'newer',
	computedParams: computed(() => note.value && note.value.channelId != null ? ({
		channelId: note.value.channelId,
	}) : undefined),
}));

function fetchNote() {
	showPrev.value = false;
	showNext.value = false;
	note.value = null;

	if (CTX_NOTE && CTX_NOTE.id === props.noteId) {
		note.value = CTX_NOTE;
		return;
	}

	misskeyApi('notes/show', {
		noteId: props.noteId,
	}).then(res => {
		note.value = res;
		const appearNote = getAppearNote(res) ?? res;
		// 古いノートは被クリップ数をカウントしていないので、2023-10-01以前のものは強制的にnotes/clipsを叩く
		if ((appearNote.clippedCount ?? 0) > 0 || new Date(appearNote.createdAt).getTime() < new Date('2023-10-01').getTime()) {
			misskeyApi('notes/clips', {
				noteId: appearNote.id,
			}).then((_clips) => {
				clips.value = _clips;
			});
		}
	}).catch(err => {
		if (['fbcc002d-37d9-4944-a6b0-d9e29f2d33ab', '145f88d2-b03d-4087-8143-a78928883c4b'].includes(err.id)) {
			pleaseLogin({
				path: '/',
				message: err.id === 'fbcc002d-37d9-4944-a6b0-d9e29f2d33ab' ? i18n.ts.thisContentsAreMarkedAsSigninRequiredByAuthor : i18n.ts.signinOrContinueOnRemote,
				openOnRemote: {
					type: 'lookup',
					url: `https://${host}/notes/${props.noteId}`,
				},
			});
		}
		error.value = err;
	});
}

watch(() => props.noteId, fetchNote, {
	immediate: true,
});

const headerActions = computed(() => []);

const headerTabs = computed(() => []);

definePage(() => ({
	title: i18n.ts.note,
	...note.value ? {
		subtitle: dateString(note.value.createdAt),
		avatar: note.value.anonymouslySendToUser ? undefined : userOf(note.value),
		path: `/notes/${note.value.id}`,
		share: {
			title: note.value.anonymouslySendToUser
				? i18n.tsx.anonymouslySendToUser({ user: note.value.anonymouslySendToUser.name ?? note.value.anonymouslySendToUser.username })
				: i18n.tsx.noteOf({ user: note.value.anonymousChannelUsername ?? note.value.user.name ?? note.value.user.username }),
			text: note.value.text,
		},
	} : {},
}));
</script>

<style lang="scss" module>
.fade-enter-active,
.fade-leave-active {
	transition: opacity 0.125s ease;
}
.fade-enter-from,
.fade-leave-to {
	opacity: 0;
}

.loadNext,
.loadPrev {
	justify-content: center;
}

.loadNext {
	margin-bottom: var(--MI-margin);
}

.loadPrev {
	margin-top: var(--MI-margin);
}

.loadButton {
	min-width: 0;
}

.note {
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-panel);
}
</style>
