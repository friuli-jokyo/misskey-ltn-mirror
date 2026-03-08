<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="note" :class="$style.root">
	<MkAvatar v-if="!note.anonymouslySendToUser" :class="[$style.avatar, prefer.s.useStickyIcons ? $style.useSticky : null]" :user="userOf(note)" :link="!note.anonymousChannelUsername" preview small/>
	<div :class="$style.main">
		<MkNoteHeader :class="$style.header" :note="note" :mini="true"/>
		<div>
			<p v-if="note.cw != null" :class="$style.cw">
				<Mfm v-if="note.cw != ''" style="margin-right: 8px;" :text="note.cw" :author="note.user" :nyaize="'respect'" :emojiUrls="note.emojis"/>
				<MkCwButton v-model="showContent" :text="note.text" :files="note.files" :poll="note.poll"/>
			</p>
			<div v-show="note.cw == null || showContent">
				<MkSubNoteContent :class="$style.text" :note="note"/>
			</div>
		</div>
		<MkA v-if="note.channel && note.channel.id !== inChannel" :class="$style.channel" :to="`/channels/${note.channel.id}`"><i class="ti ti-device-tv"></i> {{ note.channel.name }}</MkA>
	</div>
</div>
<div v-else :class="$style.deleted">
	{{ i18n.ts.deletedNote }}
</div>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
import * as Misskey from 'misskey-js';
import { hostname } from '@@/js/config.js';
import MkNoteHeader from '@/components/MkNoteHeader.vue';
import MkSubNoteContent from '@/components/MkSubNoteContent.vue';
import MkCwButton from '@/components/MkCwButton.vue';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';

const props = withDefaults(defineProps<{
	note: Misskey.entities.Note | null;
	quote?: boolean;
	inChannel?: string;
}>(), {
	quote: false,
	inChannel: '',
});

function userOf(note: Misskey.entities.Note): Misskey.entities.User {
	return note.anonymousChannelUsername ? { ...note.user, username: note.anonymousChannelUsername, avatarUrl: `${location.origin}/identicon/@${note.anonymousChannelUsername}@${hostname}` } : note.user;
}

const showContent = ref(false);
</script>

<style lang="scss" module>
.root {
	display: flex;
	margin: 0;
	padding: 0;
	font-size: 0.95em;
}

.avatar {
	flex-shrink: 0;
	display: block;
	margin: 0 10px 0 0;
	width: 34px;
	height: 34px;
	border-radius: 8px;

	&.useSticky {
		position: sticky !important;
		top: calc(16px + var(--MI-stickyTop, 0px));
		left: 0;
	}
}

.main {
	flex: 1;
	min-width: 0;
}

.header {
	margin-bottom: 2px;
}

.cw {
	cursor: default;
	display: block;
	margin: 0;
	padding: 0;
	overflow-wrap: break-word;
}

.text {
	cursor: default;
	margin: 0;
	padding: 0;
}

.channel {
	opacity: 0.7;
	font-size: 80%;
}

@container (min-width: 250px) {
	.avatar {
		margin: 0 10px 0 0;
		width: 40px;
		height: 40px;
	}
}

@container (min-width: 350px) {
	.avatar {
		margin: 0 10px 0 0;
		width: 44px;
		height: 44px;
	}
}

@container (min-width: 500px) {
	.avatar {
		margin: 0 12px 0 0;
		width: 48px;
		height: 48px;
	}
}

.deleted {
	text-align: center;
	padding: 8px !important;
	margin: 8px 8px 0 8px;
	--color: light-dark(rgba(0, 0, 0, 0.05), rgba(0, 0, 0, 0.15));
	background-size: auto auto;
	background-image: repeating-linear-gradient(135deg, transparent, transparent 10px, var(--color) 4px, var(--color) 14px);
	border-radius: 8px;
}
</style>
