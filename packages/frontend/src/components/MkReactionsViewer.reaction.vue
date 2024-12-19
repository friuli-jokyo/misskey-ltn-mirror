<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<button
	ref="buttonEl"
	v-ripple="canToggle"
	class="_button"
	:class="[$style.root, { [$style.reacted]: note.myReaction == reaction, [$style.canToggle]: canToggle, [$style.small]: defaultStore.state.reactionsDisplaySize === 'small', [$style.large]: defaultStore.state.reactionsDisplaySize === 'large', [$style.x2]: conspicuousScale === 2 }]"
	@click="toggleReaction()"
	@contextmenu.prevent.stop="menu"
>
	<MkReactionIcon :class="defaultStore.state.limitWidthOfReaction ? $style.limitWidth : ''" :reaction="reaction" :emojiUrl="note.reactionEmojis[reaction.substring(1, reaction.length - 1)]"/>
	<span :class="$style.count">{{ count }}</span>
	<TransitionGroup v-if="props.users" :name="defaultStore.state.animation ? '_transition_zoom' : ''" :class="$style.users" tag="div">
		<div v-for="(user, index) in props.users" :key="user.id" :class="[$style.user, { [$style.square]: defaultStore.state.squareAvatars }]" :style="{ zIndex: props.users.length - index }">
			<MkAvatar :class="$style.avatar" :user="user" small forceHideDecoration/>
		</div>
	</TransitionGroup>
</button>
</template>

<script lang="ts" setup>
import { computed, inject, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';
import * as Misskey from 'misskey-js';
import { getUnicodeEmoji } from '@@/js/emojilist.js';
import MkCustomEmojiDetailedDialog from './MkCustomEmojiDetailedDialog.vue';
import XDetails from '@/components/MkReactionsViewer.details.vue';
import MkReactionIcon from '@/components/MkReactionIcon.vue';
import { globalEvents } from '@/events.js';
import * as os from '@/os.js';
import { misskeyApi, misskeyApiGet } from '@/scripts/misskey-api.js';
import { useTooltip } from '@/scripts/use-tooltip.js';
import { $i } from '@/account.js';
import MkReactionEffect from '@/components/MkReactionEffect.vue';
import { claimAchievement } from '@/scripts/achievements.js';
import { defaultStore } from '@/store.js';
import { i18n } from '@/i18n.js';
import * as sound from '@/scripts/sound.js';
import { checkReactionPermissions } from '@/scripts/check-reaction-permissions.js';
import { customEmojisMap } from '@/custom-emojis.js';

const props = defineProps<{
	reaction: string;
	count: number;
	isInitial: boolean;
	note: Misskey.entities.Note;
	users?: Misskey.entities.UserLite[];
}>();

const mock = inject<boolean>('mock', false);

const emit = defineEmits<{
	(ev: 'reactionToggled', emoji: string, newCount: number): void;
}>();

const buttonEl = shallowRef<HTMLElement>();

const emojiName = computed(() => props.reaction.replace(/:/g, '').replace(/@\./, ''));
const emoji = computed(() => customEmojisMap.get(emojiName.value) ?? getUnicodeEmoji(props.reaction));
const conspicuousScale = computed(() => defaultStore.state.adaptiveReactionsDisplaySize && emoji.value.conspicuousScale || 1);

const canToggle = computed(() => {
	return !props.reaction.match(/@\w/) && $i && emoji.value && checkReactionPermissions($i, props.note, emoji.value);
});
const canGetInfo = computed(() => !props.reaction.match(/@\w/) && props.reaction.includes(':'));

const abortController = new AbortController();

onBeforeUnmount(() => abortController.abort());

async function toggleReaction() {
	if (!canToggle.value) return;
	const oldReaction = props.note.myReaction;
	if (props.note.anonymousChannelUsername && oldReaction !== props.reaction) {
		const { canceled } = await os.confirm({
			type: 'warning',
			title: i18n.ts.reactionsAreNotAnonymized,
			text: i18n.ts.areYouSure,
		});
		if (canceled) {
			return;
		}
	}
	if (oldReaction) {
		const confirm = await os.confirm({
			type: 'warning',
			text: oldReaction !== props.reaction ? i18n.ts.changeReactionConfirm : i18n.ts.cancelReactionConfirm,
		});
		if (confirm.canceled) return;

		if (oldReaction !== props.reaction) {
			sound.playMisskeySfx('reaction');
		}

		if (mock) {
			emit('reactionToggled', props.reaction, (props.count - 1));
			return;
		}

		misskeyApi('notes/reactions/delete', {
			noteId: props.note.id,
		}).then(() => {
			if (oldReaction !== props.reaction) {
				misskeyApi('notes/reactions/create', {
					noteId: props.note.id,
					reaction: props.reaction,
				});
			}
		});
	} else {
		sound.playMisskeySfx('reaction');

		if (mock) {
			emit('reactionToggled', props.reaction, (props.count + 1));
			return;
		}

		misskeyApi('notes/reactions/create', {
			noteId: props.note.id,
			reaction: props.reaction,
		});
		if (props.note.text && props.note.text.length > 100 && (Date.now() - new Date(props.note.createdAt).getTime() < 1000 * 3)) {
			claimAchievement('reactWithoutRead');
		}
	}
}

async function menu(ev) {
	if (!canGetInfo.value) return;

	os.popupMenu([{
		text: i18n.ts.info,
		icon: 'ti ti-info-circle',
		action: async () => {
			const { dispose } = os.popup(MkCustomEmojiDetailedDialog, {
				emoji: await misskeyApiGet('emoji', {
					name: props.reaction.replace(/:/g, '').replace(/@\./, ''),
				}),
			}, {
				closed: () => dispose(),
			});
		},
	}], ev.currentTarget ?? ev.target);
}

function anime() {
	globalEvents.emit('appendReaction', props.reaction);

	if (document.hidden || !defaultStore.state.animation || buttonEl.value == null) return;

	const rect = buttonEl.value.getBoundingClientRect();
	const x = rect.left + 16;
	const y = rect.top + (buttonEl.value.offsetHeight / 2);
	const { dispose } = os.popup(MkReactionEffect, { reaction: props.reaction, x, y }, {
		end: () => dispose(),
	});
}

watch(() => props.count, (newCount, oldCount) => {
	if (oldCount < newCount) anime();
});

onMounted(() => {
	if (!props.isInitial) anime();
});

if (!mock) {
	useTooltip(buttonEl, async (showing) => {
		const { dispose } = os.popup(XDetails, {
			showing,
			reaction: props.reaction,
			users: props.users
				? props.users.slice(0, 10)
				: (await misskeyApiGet('notes/reactions', {
					noteId: props.note.id,
					type: props.reaction,
					limit: 10,
					_cacheKey_: props.count,
				})).map(x => x.user),
			count: props.count,
			targetElement: buttonEl.value,
		}, {
			closed: () => dispose(),
		});
	}, 100);
}
</script>

<style lang="scss" module>
.root {
	display: inline-flex;
	height: 42px;
	margin: 2px;
	padding: 0 6px;
	font-size: 1.5em;
	border-radius: 6px;
	align-items: center;
	white-space: nowrap;
	overflow: clip;
	contain: paint;

	&.canToggle {
		background: var(--MI_THEME-buttonBg);
		--x-bg: var(--MI_THEME-buttonBg);

		&:hover {
			background: rgba(0, 0, 0, 0.1);
			--x-bg: rgba(0, 0, 0, 0.1);
		}
	}

	&:not(.canToggle) {
		cursor: default;
	}

	&.x2 {
		height: 88px;
		font-size: 4em;
		float: left;

		> .count {
			font-size: 0.2625em;
		}

		> .users {
			grid-template-rows: repeat(4, 16px);
			margin: 0 8px 8px;
		}
	}

	&.small {
		height: 32px;
		font-size: 1em;
		border-radius: 4px;

		> .count {
			font-size: 0.9em;
			line-height: 32px;
		}

		&.x2 {
			height: 68px;
			font-size: 3em;

			> .count {
				font-size: 0.3em;
			}

			> .users {
				grid-template-rows: repeat(3, 16px);
			}
		}
	}

	&.large {
		height: 52px;
		font-size: 2em;
		border-radius: 8px;

		> .count {
			font-size: 0.6em;
			line-height: 52px;
		}

		&.x2 {
			height: 108px;
			font-size: 5em;

			> .count {
				font-size: 0.24em;
			}

			> .users {
				grid-template-rows: repeat(5, 16px);
			}
		}
	}

	&.reacted, &.reacted:hover {
		background: var(--MI_THEME-accentedBg);
		--x-bg: var(--MI_THEME-accentedBg);
		color: var(--MI_THEME-accent);
		box-shadow: 0 0 0 1px var(--MI_THEME-accent) inset;

		> .count {
			color: var(--MI_THEME-accent);
		}

		> .icon {
			filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.5));
		}
	}
}

.limitWidth {
	max-width: 70px;
	object-fit: contain;
}

.count {
	font-size: 0.7em;
	line-height: 42px;
	margin: 0 0 0 4px;
}

.users {
	display: inline-grid;
	grid-auto-flow: column;
	grid-auto-columns: 16px;
	vertical-align: middle;
	margin: 0 8px;
}

.user {
	width: 24px;
	height: 24px;
	outline: 3px var(--MI_THEME-panel) solid;
	border-radius: 100%;
	background: var(--MI_THEME-panel) linear-gradient(0deg, var(--x-bg), var(--x-bg));

	&::before {
		content: "";
		position: absolute;
		display: block;
		width: 24px;
		height: 24px;
		outline: 3px var(--x-bg) solid;
		border-radius: 100%;
	}

	&.square {
		border-radius: 20%;

		&::before {
			border-radius: 20%;
		}
	}
}

.avatar {
	display: block;
	width: 24px;
	height: 24px;
}
</style>
