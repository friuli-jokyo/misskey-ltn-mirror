<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<component
	:is="prefer.s.animation ? TransitionGroup : 'div'"
	:enterActiveClass="$style.transition_x_enterActive"
	:leaveActiveClass="$style.transition_x_leaveActive"
	:enterFromClass="$style.transition_x_enterFrom"
	:leaveToClass="$style.transition_x_leaveTo"
	:moveClass="$style.transition_x_move"
	tag="div" :class="$style.root"
>
	<XReaction
		v-for="[reaction, count] in _reactions"
		:key="reaction"
		:reaction="reaction"
		:reactionEmojis="props.reactionEmojis"
		:count="count"
		:isInitial="initialReactions.has(reaction)"
		:noteId="props.noteId"
		:myReaction="props.myReaction"
		:users="reactedUsers.get(reaction)"
		:noteAnonymousChannelUsername="props.noteAnonymousChannelUsername"
		@reactionToggled="onMockToggleReaction"
	/>
	<slot v-if="hasMoreReactions" name="more"></slot>
</component>
</template>

<script lang="ts" setup>
import * as Misskey from 'misskey-js';
import { inject, nextTick, watch, ref } from 'vue';
import { TransitionGroup } from 'vue';
import { isSupportedEmoji } from '@@/js/emojilist.js';
import XReaction from '@/components/MkReactionsViewer.reaction.vue';
import { $i } from '@/i.js';
import { prefer } from '@/preferences.js';
import { customEmojisMap } from '@/custom-emojis.js';
import { misskeyApiGet } from '@/utility/misskey-api.js';
import { DI } from '@/di.js';

const props = withDefaults(defineProps<{
	noteId: Misskey.entities.Note['id'];
	reactions: Misskey.entities.Note['reactions'];
	reactionEmojis: Misskey.entities.Note['reactionEmojis'];
	myReaction: Misskey.entities.Note['myReaction'];
	noteAnonymousChannelUsername?: string | null;
	maxNumber?: number;
}>(), {
	maxNumber: Infinity,
});

const mock = inject(DI.mock, false);

const emit = defineEmits<{
	(ev: 'mockUpdateMyReaction', emoji: string, delta: number): void;
}>();

const sleep = window.requestIdleCallback as unknown
	? () => new Promise(resolve => requestIdleCallback(resolve))
	: () => nextTick().then(() => new Promise(resolve => setTimeout(resolve, 0)));

const initialReactions = new Set(Object.keys(props.reactions));
const encoder = new TextEncoder();

const _reactions = ref<[string, number][]>([]);
const hasMoreReactions = ref(false);
const reactedUsers = ref<Map<string, Misskey.entities.UserLite[]>>(new Map());

let abortController = new AbortController();

if (props.myReaction != null && !(props.myReaction in props.reactions)) {
	_reactions.value.push([props.myReaction, props.reactions[props.myReaction]]);
}

function onMockToggleReaction(emoji: string, count: number) {
	if (!mock) return;

	const i = _reactions.value.findIndex((item) => item[0] === emoji);
	if (i < 0) return;

	emit('mockUpdateMyReaction', emoji, (count - _reactions.value[i][1]));
}

function canReact(reaction: string) {
	if (!$i) return false;
	// TODO: CheckPermissions
	return !reaction.match(/@\w/) && (customEmojisMap.has(reaction) || isSupportedEmoji(reaction));
}

function getScale(name: string): number {
	if (!prefer.s.adaptiveReactionsDisplaySize) {
		return 1;
	}
	const match = name.match(/(?<=^:)\w+(?=@\.:$)/);
	if (!match) {
		return 1;
	}
	const emoji = customEmojisMap.get(match[0]);
	return emoji?.conspicuousScale || 1;
}

watch([() => props.reactions, () => props.maxNumber], ([newSource, maxNumber]) => {
	let newReactions: [string, number][] = [];
	hasMoreReactions.value = Object.keys(newSource).length > maxNumber;

	for (let i = 0; i < _reactions.value.length; i++) {
		const reaction = _reactions.value[i][0];
		if (reaction in newSource && newSource[reaction] !== 0) {
			_reactions.value[i][1] = newSource[reaction];
			newReactions.push(_reactions.value[i]);
		}
	}

	const newReactionsNames = newReactions.map(([x]) => x);
	newReactions = [
		...newReactions,
		...Object.entries(newSource)
			.sort(([emojiA, countA], [emojiB, countB]) => {
				if (prefer.s.showAvailableReactionsFirstInNote) {
					if (!canReact(emojiA) && canReact(emojiB)) return 1;
					if (canReact(emojiA) && !canReact(emojiB)) return -1;
					return (getScale(emojiB) - getScale(emojiA)) || (countB - countA);
				} else {
					return (getScale(emojiB) - getScale(emojiA)) || (countB - countA);
				}
			})
			.filter(([y], i) => i < maxNumber && !newReactionsNames.includes(y)),
	];

	newReactions = newReactions.slice(0, props.maxNumber);

	if (props.myReaction && !newReactions.map(([x]) => x).includes(props.myReaction)) {
		newReactions.push([props.myReaction, newSource[props.myReaction]]);
	}

	_reactions.value = newReactions;

	if (prefer.s.showReactedUserAvatars) {
		abortController.abort();
		abortController = new AbortController();
		sleep()
			.then(() => crypto.subtle.digest('SHA-1', encoder.encode(JSON.stringify(_reactions.value))))
			.then(async digest => {
				const _cacheKey_ = String.fromCharCode.apply(null, new Uint16Array(digest) as unknown as number[]);
				const data: Misskey.entities.NoteReaction[] = [];
				let untilId: string | undefined;
				for (;;) {
					const page = await misskeyApiGet('notes/reactions', {
						noteId: props.noteId,
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
	gap: 4px;

	&:empty {
		display: none;
	}
}
</style>
