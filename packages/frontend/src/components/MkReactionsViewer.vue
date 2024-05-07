<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<TransitionGroup
	:enterActiveClass="defaultStore.state.animation ? $style.transition_x_enterActive : ''"
	:leaveActiveClass="defaultStore.state.animation ? $style.transition_x_leaveActive : ''"
	:enterFromClass="defaultStore.state.animation ? $style.transition_x_enterFrom : ''"
	:leaveToClass="defaultStore.state.animation ? $style.transition_x_leaveTo : ''"
	:moveClass="defaultStore.state.animation ? $style.transition_x_move : ''"
	tag="div" :class="$style.root"
>
	<XReaction v-for="[reaction, count] in reactions" :key="reaction" :reaction="reaction" :count="count" :isInitial="initialReactions.has(reaction)" :note="note" :users="reactedUsers.get(reaction)" @reactionToggled="onMockToggleReaction"/>
	<slot v-if="hasMoreReactions" name="more"/>
</TransitionGroup>
</template>

<script lang="ts" setup>
import * as Misskey from 'misskey-js';
import { inject, nextTick, watch, ref } from 'vue';
import XReaction from '@/components/MkReactionsViewer.reaction.vue';
import { customEmojisMap } from '@/custom-emojis.js';
import { misskeyApiGet } from '@/scripts/misskey-api.js';
import { defaultStore } from '@/store.js';

const props = withDefaults(defineProps<{
	note: Misskey.entities.Note;
	maxNumber?: number;
}>(), {
	maxNumber: Infinity,
});

const mock = inject<boolean>('mock', false);

const emit = defineEmits<{
	(ev: 'mockUpdateMyReaction', emoji: string, delta: number): void;
}>();

const sleep = window.requestIdleCallback as unknown
	? () => new Promise(resolve => requestIdleCallback(resolve))
	: () => nextTick().then(() => new Promise(resolve => setTimeout(resolve, 0)));

const initialReactions = new Set(Object.keys(props.note.reactions));
const encoder = new TextEncoder();

const reactions = ref<[string, number][]>([]);
const hasMoreReactions = ref(false);
const reactedUsers = ref<Map<string, Misskey.entities.UserLite[]>>(new Map());

let abortController = new AbortController();

if (props.note.myReaction && !Object.keys(reactions.value).includes(props.note.myReaction)) {
	reactions.value[props.note.myReaction] = props.note.reactions[props.note.myReaction];
}

function onMockToggleReaction(emoji: string, count: number) {
	if (!mock) return;

	const i = reactions.value.findIndex((item) => item[0] === emoji);
	if (i < 0) return;

	emit('mockUpdateMyReaction', emoji, (count - reactions.value[i][1]));
}

function getScale(name: string): number {
	if (!defaultStore.state.adaptiveReactionsDisplaySize) {
		return 1;
	}
	const match = name.match(/(?<=^:)\w+(?=@\.:$)/);
	if (!match) {
		return 1;
	}
	const emoji = customEmojisMap.get(match[0]);
	return emoji?.conspicuousScale || 1;
}

watch([() => props.note.reactions, () => props.maxNumber], ([newSource, maxNumber]) => {
	let newReactions: [string, number][] = [];
	hasMoreReactions.value = Object.keys(newSource).length > maxNumber;

	for (let i = 0; i < reactions.value.length; i++) {
		const reaction = reactions.value[i][0];
		if (reaction in newSource && newSource[reaction] !== 0) {
			reactions.value[i][1] = newSource[reaction];
			newReactions.push(reactions.value[i]);
		}
	}

	const newReactionsNames = newReactions.map(([x]) => x);
	newReactions = [
		...newReactions,
		...Object.entries(newSource)
			.sort((a, b) => (getScale(b[0]) - getScale(a[0])) || (b[1] - a[1]))
			.filter(([y], i) => i < maxNumber && !newReactionsNames.includes(y)),
	];

	newReactions = newReactions.slice(0, props.maxNumber);

	if (props.note.myReaction && !newReactions.map(([x]) => x).includes(props.note.myReaction)) {
		newReactions.push([props.note.myReaction, newSource[props.note.myReaction]]);
	}

	reactions.value = newReactions;

	if (defaultStore.state.showReactedUserAvatars) {
		abortController.abort();
		abortController = new AbortController();
		sleep()
			.then(() => crypto.subtle.digest('SHA-1', encoder.encode(JSON.stringify(reactions.value))))
			.then(async digest => {
				const _cacheKey_ = String.fromCharCode.apply(null, new Uint16Array(digest) as unknown as number[]);
				const data: Misskey.entities.NoteReaction[] = [];
				let untilId: string | undefined;
				for (;;) {
					const page = await misskeyApiGet('notes/reactions', {
						noteId: props.note.id,
						limit: 100,
						untilId,
						_cacheKey_,
					}, abortController.signal);
					if (!page.length) break;
					data.push(...page);
					untilId = page.at(-1)!.id;
					if (!untilId || page.length < 100) break;
					await sleep();
				}
				return data.reverse();
			})
			.then(data => {
				const map = new Map();
				for (const item of data) {
					if (map.has(item.type)) {
						map.get(item.type)!.push(item.user);
					} else {
						map.set(item.type, [item.user]);
					}
				}
				reactedUsers.value = map;
			});
	}
}, { immediate: true, deep: true });
</script>

<style lang="scss" module>
.transition_x_move,
.transition_x_enterActive,
.transition_x_leaveActive {
	transition: opacity 0.2s cubic-bezier(0,.5,.5,1), transform 0.2s cubic-bezier(0,.5,.5,1) !important;
}
.transition_x_enterFrom,
.transition_x_leaveTo {
	opacity: 0;
	transform: scale(0.7);
}
.transition_x_leaveActive {
	position: absolute;
}

.root {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	margin: 4px -2px 0 -2px;
	contain: layout;

	&:empty {
		display: none;
	}
}
</style>
