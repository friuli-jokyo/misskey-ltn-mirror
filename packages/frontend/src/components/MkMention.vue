<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkA v-user-preview="canonical" :class="[$style.root, { [$style.isMe]: isMe }]" :to="url" :style="{ background: bgCss }" :behavior="navigationBehavior">
	<img :class="$style.icon" :src="avatarUrl" alt="">
	<span>
		<span>@{{ username }}</span>
		<span v-if="(host != localHost) || defaultStore.state.showFullAcct" :class="$style.host">@{{ toUnicode(host) }}</span>
	</span>
</MkA>
</template>

<script lang="ts" setup>
import { toUnicode } from 'punycode';
import * as Misskey from 'misskey-js';
import { Ref, computed, inject, shallowRef } from 'vue';
import tinycolor from 'tinycolor2';
import { host as localHost } from '@/config.js';
import { $i } from '@/account.js';
import { defaultStore } from '@/store.js';
import { getStaticImageUrl } from '@/scripts/media-proxy.js';
import { MkABehavior } from '@/components/global/MkA.vue';

const props = defineProps<{
	username: string;
	host: string;
	navigationBehavior?: MkABehavior;
}>();

export type AvatarsMap = Map<Misskey.entities.User['id'], Pick<Misskey.entities.User, 'id' | 'name' | 'username' | 'host' | 'avatarBlurhash'> & { [T in keyof Misskey.entities.User & 'avatarUrl']: NonNullable<Misskey.entities.User[T]> }>;

const avatarsMap = inject<Ref<AvatarsMap>>('avatarsMap', () => shallowRef(new Map()), true);

const canonical = props.host === localHost ? `@${props.username}` : `@${props.username}@${toUnicode(props.host)}`;

const url = `/${canonical}`;

const isMe = $i && (
	`@${props.username}@${toUnicode(props.host)}` === `@${$i.username}@${toUnicode(localHost)}`.toLowerCase()
);

const bg = tinycolor(getComputedStyle(document.documentElement).getPropertyValue(isMe ? '--mentionMe' : '--mention'));
bg.setAlpha(0.1);
const bgCss = bg.toRgbString();

const baseUrl = computed(() => {
	for (const user of avatarsMap.value.values()) {
		if (user.username === props.username && user.host === props.host) {
			return user.avatarUrl;
		}
	}
	return `/avatar/@${props.username}@${props.host}`;
});

const avatarUrl = computed(() => defaultStore.state.disableShowingAnimatedImages ? getStaticImageUrl(baseUrl.value) : baseUrl.value);
</script>

<style lang="scss" module>
.root {
	display: inline-block;
	padding: 4px 8px 4px 4px;
	border-radius: 999px;
	color: var(--mention);

	&.isMe {
		color: var(--mentionMe);
	}
}

.icon {
	width: 1.5em;
	height: 1.5em;
	object-fit: cover;
	margin: 0 0.2em 0 0;
	vertical-align: bottom;
	border-radius: 100%;
}

.host {
	opacity: 0.5;
}
</style>
