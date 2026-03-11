<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<button
	ref="buttonEl"
	v-ripple="canToggle"
	class="_button"
	:class="[$style.root, { [$style.reacted]: myReaction == reaction, [$style.canToggle]: canToggle, [$style.small]: prefer.s.reactionsDisplaySize === 'small', [$style.large]: prefer.s.reactionsDisplaySize === 'large', [$style.x2]: conspicuousScale === 2 }]"
	@click="toggleReaction()"
	@contextmenu.prevent.stop="menu"
>
	<MkReactionIcon style="pointer-events: none;" :class="prefer.s.limitWidthOfReaction ? $style.limitWidth : ''" :reaction="reaction" :emojiUrl="reactionEmojis[reaction.substring(1, reaction.length - 1)]"/>
	<span :class="$style.count">{{ count }}</span>
	<TransitionGroup v-if="props.users" :name="prefer.s.animation ? '_transition_zoom' : ''" :class="$style.users" tag="div">
		<div v-for="(user, index) in props.users" :key="user.id" :class="[$style.user, { [$style.square]: prefer.s.squareAvatars }]" :style="{ zIndex: props.users.length - index }">
			<MkAvatar :class="$style.avatar" :user="user" small forceHideDecoration/>
		</div>
	</TransitionGroup>
</button>
</template>

<script lang="ts" setup>
import { computed, inject, onMounted, useTemplateRef, watch } from 'vue';
import * as Misskey from 'misskey-js';
import { getUnicodeEmojiOrNull } from '@@/js/emojilist.js';
import MkCustomEmojiDetailedDialog from './MkCustomEmojiDetailedDialog.vue';
import type { MenuItem } from '@/types/menu';
import XDetails from '@/components/MkReactionsViewer.details.vue';
import MkReactionIcon from '@/components/MkReactionIcon.vue';
import MkAvatar from '@/components/global/MkAvatar.vue';
import * as os from '@/os.js';
import { misskeyApi, misskeyApiGet } from '@/utility/misskey-api.js';
import { useTooltip } from '@/composables/use-tooltip.js';
import { $i } from '@/i.js';
import MkReactionEffect from '@/components/MkReactionEffect.vue';
import { i18n } from '@/i18n.js';
import * as sound from '@/utility/sound.js';
import { checkReactionPermissions } from '@/utility/check-reaction-permissions.js';
import { customEmojisMap } from '@/custom-emojis.js';
import { prefer } from '@/preferences.js';
import { DI } from '@/di.js';
import { noteEvents } from '@/composables/use-note-capture.js';
import { mute as muteEmoji, unmute as unmuteEmoji, checkMuted as isEmojiMuted } from '@/utility/emoji-mute.js';
import { haptic } from '@/utility/haptic.js';

const props = defineProps<{
	noteId: Misskey.entities.Note['id'];
	reaction: string;
	reactionEmojis: Misskey.entities.Note['reactionEmojis'];
	myReaction: Misskey.entities.Note['myReaction'];
	count: number;
	isInitial: boolean;
	noteAnonymousChannelUsername?: string | null;
	users?: Misskey.entities.UserLite[];
}>();

const mock = inject(DI.mock, false);

const emit = defineEmits<{
	(ev: 'reactionToggled', emoji: string, newCount: number): void;
}>();

const buttonEl = useTemplateRef('buttonEl');

const emojiName = computed(() => props.reaction.replace(/:/g, '').replace(/@\./, ''));

const emoji = computed(() => {
	return customEmojisMap.get(emojiName.value) ?? getUnicodeEmojiOrNull(props.reaction);
});

const conspicuousScale = computed(() => {
	return (prefer.s.adaptiveReactionsDisplaySize && emoji.value?.conspicuousScale) ? 2 : 1;
});

const canToggle = computed(() => {
	const emoji = customEmojisMap.get(emojiName.value) ?? getUnicodeEmojiOrNull(props.reaction);

	// TODO
	//return !props.reaction.match(/@\w/) && $i && emoji && checkReactionPermissions($i, props.note, emoji);
	return props.reaction.match(/@\w/) == null && $i != null && emoji != null;
});
const canGetInfo = computed(() => !props.reaction.match(/@\w/) && props.reaction.includes(':'));
const isLocalCustomEmoji = props.reaction[0] === ':' && props.reaction.includes('@.');

async function toggleReaction() {
	if (!canToggle.value) return;
	if ($i == null) return;

	const me = $i;

	const oldReaction = props.myReaction;
	if (oldReaction) {
		const confirm = await os.confirm({
			type: 'warning',
			text: oldReaction !== props.reaction ? i18n.ts.changeReactionConfirm : i18n.ts.cancelReactionConfirm,
		});
		if (confirm.canceled) return;

		if (oldReaction !== props.reaction) {
			sound.playMisskeySfx('reaction');
			haptic();
		}

		if (mock) {
			emit('reactionToggled', props.reaction, (props.count - 1));
			return;
		}

		misskeyApi('notes/reactions/delete', {
			noteId: props.noteId,
		}).then(() => {
			noteEvents.emit(`unreacted:${props.noteId}`, {
				userId: me.id,
				reaction: oldReaction,
			});
			if (oldReaction !== props.reaction) {
				const confirm = props.noteAnonymousChannelUsername
					? os.confirm({
						type: 'warning',
						title: i18n.ts.reactionsAreNotAnonymized,
						text: i18n.ts.areYouSure,
					})
					: Promise.resolve({ canceled: false });
				confirm.then(({ canceled }) => {
					if (canceled) return;
					misskeyApi('notes/reactions/create', {
						noteId: props.noteId,
						reaction: props.reaction,
					}).then(() => {
						const emoji = customEmojisMap.get(emojiName.value);
						if (emoji == null) return;
						noteEvents.emit(`reacted:${props.noteId}`, {
							userId: me.id,
							reaction: props.reaction,
							emoji: emoji,
						});
					});
				});
			}
		});
	} else {
		if (prefer.s.confirmOnReact) {
			const confirm = await os.confirm({
				type: 'question',
				text: i18n.tsx.reactAreYouSure({ emoji: props.reaction.replace('@.', '') }),
			});

			if (confirm.canceled) return;
		}

		if (props.noteAnonymousChannelUsername) {
			const confirm = await os.confirm({
				type: 'warning',
				title: i18n.ts.reactionsAreNotAnonymized,
				text: i18n.ts.areYouSure,
			});

			if (confirm.canceled) return;
		}

		sound.playMisskeySfx('reaction');
		haptic();

		if (mock) {
			emit('reactionToggled', props.reaction, (props.count + 1));
			return;
		}

		misskeyApi('notes/reactions/create', {
			noteId: props.noteId,
			reaction: props.reaction,
		}).then(() => {
			const emoji = customEmojisMap.get(emojiName.value);
			if (emoji == null) return;

			noteEvents.emit(`reacted:${props.noteId}`, {
				userId: me.id,
				reaction: props.reaction,
				emoji: emoji,
			});
		});
		// TODO: 上位コンポーネントでやる
		//if (props.note.text && props.note.text.length > 100 && (Date.now() - new Date(props.note.createdAt).getTime() < 1000 * 3)) {
		//	claimAchievement('reactWithoutRead');
		//}
	}
}

async function menu(ev: PointerEvent) {
	let menuItems: MenuItem[] = [];

	if (canGetInfo.value) {
		menuItems.push({
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
		});
	}

	if (isEmojiMuted(props.reaction).value) {
		menuItems.push({
			text: i18n.ts.emojiUnmute,
			icon: 'ti ti-mood-smile',
			action: () => {
				os.confirm({
					type: 'question',
					title: i18n.tsx.unmuteX({ x: isLocalCustomEmoji ? `:${emojiName.value}:` : props.reaction }),
				}).then(({ canceled }) => {
					if (canceled) return;
					unmuteEmoji(props.reaction);
				});
			},
		});
	} else {
		menuItems.push({
			text: i18n.ts.emojiMute,
			icon: 'ti ti-mood-off',
			action: () => {
				os.confirm({
					type: 'question',
					title: i18n.tsx.muteX({ x: isLocalCustomEmoji ? `:${emojiName.value}:` : props.reaction }),
				}).then(({ canceled }) => {
					if (canceled) return;
					muteEmoji(props.reaction);
				});
			},
		});
	}

	os.popupMenu(menuItems, ev.currentTarget ?? ev.target);
}

function anime() {
	if (window.document.hidden || !prefer.s.animation || buttonEl.value == null) return;

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
		if (buttonEl.value == null) return;

		const { dispose } = os.popup(XDetails, {
			showing,
			reaction: props.reaction,
			users: props.users
				? props.users.slice(0, 10)
				: (await misskeyApiGet('notes/reactions', {
					noteId: props.noteId,
					type: props.reaction,
					limit: 10,
					_cacheKey_: props.count,
				})).map(x => x.user),
			count: props.count,
			anchorElement: buttonEl.value,
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
		--x-bg: var(--MI_THEME-buttonBg);
		background: var(--x-bg);

		&:hover {
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
		--x-bg: var(--MI_THEME-accentedBg);
		background: var(--MI_THEME-accentedBg);
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
	background: var(--MI_THEME-panel) linear-gradient(0deg, var(
--x-bg), var(--x-bg));

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

.count {
	font-size: 0.7em;
	line-height: 42px;
	margin: 0 0 0 4px;
}
</style>
