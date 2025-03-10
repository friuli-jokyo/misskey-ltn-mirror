<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<header :class="$style.root">
	<div v-if="mock" :class="$style.name">
		<MkUserName :user="note.user"/>
	</div>
	<div v-else-if="note.anonymouslySendToUser" v-user-preview="note.user.id" :class="$style.name">
		<I18n :src="i18n.ts.anonymouslySendToUser" tag="span">
			<template #user>
				<MkA v-user-preview="note.anonymouslySendToUser.id" :to="userPage(note.anonymouslySendToUser)">
					<MkUserName :user="note.anonymouslySendToUser"/>
				</MkA>
			</template>
		</I18n>
	</div>
	<div v-else-if="note.anonymousChannelUsername" v-user-preview="note.user.id" :class="$style.name">
		<MkUserName :user="userOf(note)"/>
	</div>
	<MkA v-else v-user-preview="note.user.id" :class="$style.name" :to="userPage(note.user)">
		<MkUserName :user="userOf(note)"/>
	</MkA>
	<div v-if="note.user.isBot" :class="$style.isBot">{{ note.user.username === 'instance.actor' && note.user.host === null ? 'system' : 'bot' }}</div>
	<div v-if="!note.anonymouslySendToUser && !note.anonymousChannelUsername" :class="$style.username"><MkAcct :user="note.user"/></div>
	<div v-if="note.user.badgeRoles" :class="$style.badgeRoles">
		<img v-for="(role, i) in note.user.badgeRoles" :key="i" v-tooltip="role.name" :class="$style.badgeRole" :src="role.iconUrl!"/>
	</div>
	<div :class="$style.info">
		<div v-if="mock">
			<MkTime :time="note.createdAt" colored/>
		</div>
		<MkA v-else :to="notePage(note)">
			<MkTime :time="note.createdAt" colored/>
		</MkA>
		<span v-if="note.visibility !== 'public'" style="margin-left: 0.5em;" :title="i18n.ts._visibility[note.visibility]">
			<i v-if="note.visibility === 'home'" class="ti ti-home"></i>
			<i v-else-if="note.visibility === 'followers'" class="ti ti-lock"></i>
			<i v-else-if="note.visibility === 'specified'" ref="specified" class="ti ti-mail"></i>
		</span>
		<span v-if="note.localOnly" style="margin-left: 0.5em;" :title="i18n.ts._visibility['disableFederation']"><i class="ti ti-rocket-off"></i></span>
		<span v-if="note.channel" style="margin-left: 0.5em;" :title="note.channel.name"><i class="ti ti-device-tv"></i></span>
	</div>
</header>
</template>

<script lang="ts" setup>
import { inject } from 'vue';
import * as Misskey from 'misskey-js';
import { hostname } from '@@/js/config.js';
import { i18n } from '@/i18n.js';
import { notePage } from '@/filters/note.js';
import { userPage } from '@/filters/user.js';
import { defaultStore } from '@/store.js';

defineProps<{
	note: Misskey.entities.Note;
}>();

function userOf(note: Misskey.entities.Note): Misskey.entities.User {
	return note.anonymousChannelUsername ? { ...note.user, username: note.anonymousChannelUsername, avatarUrl: `${location.origin}/identicon/@${note.anonymousChannelUsername}@${hostname}` } : note.user;
}

const mock = inject<boolean>('mock', false);
</script>

<style lang="scss" module>
.root {
	display: flex;
	align-items: baseline;
	white-space: nowrap;
}

.name {
	flex-shrink: 1;
	display: block;
	margin: 0 .5em 0 0;
	padding: 0;
	overflow: hidden;
	font-size: 1em;
	font-weight: bold;
	text-decoration: none;
	text-overflow: ellipsis;

	&:hover {
		text-decoration: underline;
	}
}

.isBot {
	flex-shrink: 0;
	align-self: center;
	margin: 0 .5em 0 0;
	padding: 1px 6px;
	font-size: 80%;
	border: solid 0.5px var(--MI_THEME-divider);
	border-radius: 3px;
}

.username {
	flex-shrink: 9999999;
	margin: 0 .5em 0 0;
	overflow: hidden;
	text-overflow: ellipsis;
}

.info {
	flex-shrink: 0;
	margin-left: auto;
	font-size: 0.9em;
}

.badgeRoles {
	margin: 0 .5em 0 0;
}

.badgeRole {
	height: 1.3em;
	vertical-align: -20%;

	& + .badgeRole {
		margin-left: 0.2em;
	}
}
</style>
