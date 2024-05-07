<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="user" :class="$style.root">
	<i class="ti ti-plane-departure" style="margin-right: 8px;"></i>
	{{ i18n.ts.accountMoved }}
	<MkMention :class="$style.link" :username="user.username" :host="user.host ?? localHost"/>
</div>
</template>

<script lang="ts" setup>
import { computed, provide, ref } from 'vue';
import * as Misskey from 'misskey-js';
import MkMention, { type AvatarsMap } from './MkMention.vue';
import { i18n } from '@/i18n.js';
import { host as localHost } from '@/config.js';
import { misskeyApi } from '@/scripts/misskey-api.js';

const user = ref<Misskey.entities.UserLite>();

const avatarsMap = computed(() => {
	const value: AvatarsMap = new Map();
	if (user.value) {
		value.set(user.value.id, {
			id: user.value.id,
			name: user.value.name,
			username: user.value.username,
			host: user.value.host,
			avatarBlurhash: user.value.avatarBlurhash,
			avatarUrl: user.value.avatarUrl!,
		});
	}
	return value;
});

const props = defineProps<{
	movedTo: string; // user id
}>();

misskeyApi('users/show', { userId: props.movedTo }).then(u => user.value = u);

provide('avatarsMap', avatarsMap);
</script>

<style lang="scss" module>
.root {
	padding: 16px;
	font-size: 90%;
	background: var(--infoWarnBg);
	color: var(--error);
	border-radius: var(--radius);
}

.link {
	margin-left: 4px;
}
</style>
