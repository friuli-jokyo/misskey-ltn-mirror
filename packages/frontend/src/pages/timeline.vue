<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkStickyContainer>
	<template #header><MkPageHeader v-model:tab="src" :actions="headerActions" :tabs="$i ? headerTabs : headerTabsWhenNotLogin" :displayMyAvatar="true"/></template>
	<MkSpacer :contentMax="800">
		<MkHorizontalSwipe v-model:tab="src" :tabs="$i ? headerTabs : headerTabsWhenNotLogin">
			<div :key="src" ref="rootEl" v-hotkey.global="keymap">
				<TransitionGroup :name="defaultStore.state.animation ? '_transition_list' : ''">
					<template v-if="a1on2024enabled">
						<canvas ref="canvas2024" :class="$style.canvas"/>
						<MkButton :class="$style.canvasActionButton" @click="canvas2024WithSound = !canvas2024WithSound"><i class="ti" :class="canvas2024WithSound ? 'ti-volume' : 'ti-volume-off'"></i></MkButton>
					</template>
					<MkInfo v-if="['home', 'local', 'social', 'global'].includes(src) && !defaultStore.reactiveState.timelineTutorials.value[src]" style="margin-bottom: var(--margin);" closable @close="closeTutorial()">
						{{ i18n.ts._timelineDescription[src] }}
					</MkInfo>
					<MkPostForm v-if="defaultStore.reactiveState.showFixedPostForm.value" :class="$style.postForm" class="post-form _panel" fixed style="margin-bottom: var(--margin);"/>
					<div v-if="queue > 0" :class="$style.new"><button class="_buttonPrimary" :class="$style.newButton" @click="top()">{{ i18n.ts.newNoteRecived }}</button></div>
					<div :class="$style.tl">
						<MkTimeline
							ref="tlComponent"
							:key="src + withRenotes + withReplies + onlyFiles"
							:src="src.split(':')[0]"
							:list="src.split(':')[1]"
							:withRenotes="withRenotes"
							:withReplies="withReplies"
							:onlyFiles="onlyFiles"
							:sound="true"
							@queue="queueUpdated"
						/>
					</div>
				</TransitionGroup>
			</div>
		</MkHorizontalSwipe>
	</MkSpacer>
</MkStickyContainer>
</template>

<script lang="ts" setup>
import * as Matter from 'matter-js';
import * as mfm from 'mfm-js';
import * as Misskey from 'misskey-js';
import { computed, onUnmounted, watch, provide, shallowRef, ref } from 'vue';
import type { Tab } from '@/components/global/MkPageHeader.tabs.vue';
import MkButton from '@/components/MkButton.vue';
import MkTimeline from '@/components/MkTimeline.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkPostForm from '@/components/MkPostForm.vue';
import MkHorizontalSwipe from '@/components/MkHorizontalSwipe.vue';
import MkRippleEffect from '@/components/MkRippleEffect.vue';
import { checkWordMute } from '@/scripts/check-word-mute.js';
import { getStaticImageUrl } from '@/scripts/media-proxy';
import { scroll } from '@/scripts/scroll.js';
import { globalEvents } from '@/events';
import * as os from '@/os.js';
import { misskeyApi } from '@/scripts/misskey-api.js';
import { defaultStore } from '@/store.js';
import { i18n } from '@/i18n.js';
import { instance } from '@/instance.js';
import { $i } from '@/account.js';
import { localDate, a1on2024enabled } from '@/ref.js';
import * as sound from '@/scripts/sound.js';
import { definePageMetadata } from '@/scripts/page-metadata.js';
import { antennasCache, userListsCache } from '@/cache.js';
import { deviceKind } from '@/scripts/device-kind.js';
import { deepMerge } from '@/scripts/merge.js';
import { MenuItem } from '@/types/menu.js';
import { miLocalStorage } from '@/local-storage.js';

provide('shouldOmitHeaderTitle', true);

const isLocalTimelineAvailable = ($i == null && instance.policies.ltlAvailable) || ($i != null && $i.policies.ltlAvailable);
const isGlobalTimelineAvailable = ($i == null && instance.policies.gtlAvailable) || ($i != null && $i.policies.gtlAvailable);
const keymap = {
	't': focus,
};

const tlComponent = shallowRef<InstanceType<typeof MkTimeline>>();
const rootEl = shallowRef<HTMLElement>();
const canvas2024 = shallowRef<HTMLCanvasElement>();
const canvas2024WithSound = ref(false);
const render2024Map = new Map<HTMLCanvasElement, Matter.Render>();
const runner2024Map = new Map<HTMLCanvasElement, Matter.Runner>();
const timelineHandler2024Map = new Map<HTMLCanvasElement, (note: Misskey.entities.Note) => void>();
const reactionHandler2024Map = new Map<HTMLCanvasElement, (reaction: string) => void>();

const queue = ref(0);
const srcWhenNotSignin = ref<'local' | 'global'>(isLocalTimelineAvailable ? 'local' : 'global');
const src = computed<'home' | 'local' | 'social' | 'global' | `list:${string}`>({
	get: () => ($i ? defaultStore.reactiveState.tl.value.src : srcWhenNotSignin.value),
	set: (x) => saveSrc(x),
});
const withRenotes = computed<boolean>({
	get: () => defaultStore.reactiveState.tl.value.filter.withRenotes,
	set: (x) => saveTlFilter('withRenotes', x),
});

// computed内での無限ループを防ぐためのフラグ
const localSocialTLFilterSwitchStore = ref<'withReplies' | 'onlyFiles' | false>('withReplies');

const withReplies = computed<boolean>({
	get: () => {
		if (!$i) return false;
		if (['local', 'social'].includes(src.value) && localSocialTLFilterSwitchStore.value === 'onlyFiles') {
			return false;
		} else {
			return defaultStore.reactiveState.tl.value.filter.withReplies;
		}
	},
	set: (x) => saveTlFilter('withReplies', x),
});
const onlyFiles = computed<boolean>({
	get: () => {
		if (['local', 'social'].includes(src.value) && localSocialTLFilterSwitchStore.value === 'withReplies') {
			return false;
		} else {
			return defaultStore.reactiveState.tl.value.filter.onlyFiles;
		}
	},
	set: (x) => saveTlFilter('onlyFiles', x),
});

watch([withReplies, onlyFiles], ([withRepliesTo, onlyFilesTo]) => {
	if (withRepliesTo) {
		localSocialTLFilterSwitchStore.value = 'withReplies';
	} else if (onlyFilesTo) {
		localSocialTLFilterSwitchStore.value = 'onlyFiles';
	} else {
		localSocialTLFilterSwitchStore.value = false;
	}
});

const withSensitive = computed<boolean>({
	get: () => defaultStore.reactiveState.tl.value.filter.withSensitive,
	set: (x) => saveTlFilter('withSensitive', x),
});

watch(canvas2024, (value, oldValue) => {
	if (oldValue) {
		const render = render2024Map.get(oldValue);
		if (render) {
			Matter.Render.stop(render);
		}
		const runner = runner2024Map.get(oldValue);
		if (runner) {
			Matter.Runner.stop(runner);
		}
	}
	if (!value) {
		return;
	}
	const engine = Matter.Engine.create({
		constraintIterations: 4,
		positionIterations: 8,
		velocityIterations: 8,
	});
	const render = Matter.Render.create({
		canvas: value,
		engine,
		options: {
			width: 800,
			height: 450,
			background: 'transparent',
			wireframeBackground: 'transparent', // transparent to hide
			wireframes: false,
			showSleeping: false,
			pixelRatio: window.devicePixelRatio,
		},
	});
	value.removeAttribute('style');
	render2024Map.set(value, render);
	Matter.Render.run(render);
	const runner = Matter.Runner.create();
	runner2024Map.set(value, runner);
	Matter.Runner.run(runner, engine);
	const ground = Matter.Bodies.rectangle(400, 500, 800, 100, { isStatic: true, label: 'Ground' });
	const pit = Matter.Bodies.rectangle(400, 5000, 80000, 100, { isStatic: true, label: 'Pit' });
	Matter.Composite.add(engine.world, [ground, pit]);
	Matter.Events.on(engine, 'collisionStart', (event) => {
		for (const pair of event.pairs) {
			if (pair.bodyA.label === 'Pit') {
				Matter.Composite.remove(engine.world, pair.bodyB);
			} else if (pair.bodyB.label === 'Pit') {
				Matter.Composite.remove(engine.world, pair.bodyA);
			} else if (pair.bodyA.label === pair.bodyB.label) {
				const aspect = (Math.max(...pair.bodyA.vertices.map(v => v.x)) - Math.min(...pair.bodyA.vertices.map(v => v.x))) / (Math.max(...pair.bodyA.vertices.map(v => v.y)) - Math.min(...pair.bodyA.vertices.map(v => v.y)));
				const rect = value.getBoundingClientRect();
				const x = (pair.bodyA.position.x + pair.bodyB.position.x) / 2;
				const y = (pair.bodyA.position.y + pair.bodyB.position.y) / 2;
				os.popup(MkRippleEffect, { x: x + rect.x, y: y + rect.y }, {}, 'end');
				Matter.Composite.remove(engine.world, [pair.bodyA, pair.bodyB]);
				if (canvas2024WithSound.value) {
					sound.playUrl('/client-assets/drop-and-fusion/fusion.mp3', {
						volume: 1,
						pan: (x - 400) / 400,
						playbackRate: 1 / Math.log1p(aspect),
					});
				}
			} else if (canvas2024WithSound.value) {
				const x = pair.activeContacts[0]?.vertex.x ?? (pair.bodyA.position.x + pair.bodyB.position.x) / 2;
				const aspectA = (Math.max(...pair.bodyA.vertices.map(v => v.x)) - Math.min(...pair.bodyA.vertices.map(v => v.x))) / (Math.max(...pair.bodyA.vertices.map(v => v.y)) - Math.min(...pair.bodyA.vertices.map(v => v.y)));
				const aspectB = (Math.max(...pair.bodyB.vertices.map(v => v.x)) - Math.min(...pair.bodyB.vertices.map(v => v.x))) / (Math.max(...pair.bodyB.vertices.map(v => v.y)) - Math.min(...pair.bodyB.vertices.map(v => v.y)));
				sound.playUrl('/client-assets/drop-and-fusion/collision.mp3', {
					volume: Math.min(1, aspectA / Math.E),
					pan: (x - 400) / 400,
					playbackRate: 1 / Math.log1p(aspectA),
				});
				sound.playUrl('/client-assets/drop-and-fusion/collision.mp3', {
					volume: Math.min(1, aspectB / Math.E),
					pan: (x - 400) / 400,
					playbackRate: 1 / Math.log1p(aspectB),
				});
			}
		}
	});
	const drop = (name: string) => {
		const path = `/emoji/${name}.webp`;
		const url = defaultStore.reactiveState.disableShowingAnimatedImages.value
			? getStaticImageUrl(path)
			: path;
		const ready: Promise<HTMLImageElement> = render.textures[url] ? Promise.resolve(render.textures[url]) : new Promise((resolve) => {
			const image = new Image();
			image.src = url;
			image.decode().then(() => {
				resolve(render.textures[url] = image);
			});
		});
		ready.then(image => {
			const aspect = image.naturalWidth / image.naturalHeight;
			const marginX = 12 * aspect;
			const x = Math.random() * (800 - marginX * 2) + marginX;
			const y = Math.min(0, ...Matter.Composite.allBodies(engine.world).map(b => b.position.y)) - 24;
			const body = Matter.Bodies.rectangle(x, y, 24 * aspect, 24, {
				label: `:${name}:`,
				render: {
					sprite: {
						texture: url,
						xScale: 24 / image.naturalHeight,
						yScale: 24 / image.naturalHeight,
					},
				},
			});
			Matter.Composite.add(engine.world, body);
		});
	};
	const timelineHandler = (note: Misskey.entities.Note) => {
		const appearNote = note.renote && !note.text && note.cw == null && !note.files?.length && !note.poll ? note.renote : note;
		if (appearNote.user.host || !appearNote.text || appearNote.cw != null || checkWordMute(note, $i, $i?.mutedWords as (string | string[])[])) {
			return;
		}
		const ast = mfm.parseSimple(appearNote.text);
		for (const node of ast) {
			if (node.type !== 'emojiCode') {
				continue;
			}
			drop(node.props.name);
		}
	};
	globalEvents.on('prependTimeline', timelineHandler);
	timelineHandler2024Map.set(value, timelineHandler);
	const reactionHandler = (reaction: string) => {
		if (reaction.startsWith(':') && reaction.endsWith('@.:')) {
			drop(reaction.slice(1, -3));
		}
	};
	globalEvents.on('appendReaction', reactionHandler);
	reactionHandler2024Map.set(value, reactionHandler);
});

watch(src, () => {
	queue.value = 0;
});

watch(withSensitive, () => {
	// これだけはクライアント側で完結する処理なので手動でリロード
	tlComponent.value?.reloadTimeline();
});

onUnmounted(() => {
	for (const render of render2024Map.values()) {
		Matter.Render.stop(render);
	}
	for (const runner of runner2024Map.values()) {
		Matter.Runner.stop(runner);
	}
	for (const handler of timelineHandler2024Map.values()) {
		globalEvents.off('prependTimeline', handler);
	}
	for (const handler of reactionHandler2024Map.values()) {
		globalEvents.off('appendReaction', handler);
	}
});

function queueUpdated(q: number): void {
	queue.value = q;
}

function top(): void {
	if (rootEl.value) scroll(rootEl.value, { top: 0 });
}

async function chooseList(ev: MouseEvent): Promise<void> {
	const lists = await userListsCache.fetch();
	const items: MenuItem[] = [
		...lists.map(list => ({
			type: 'link' as const,
			text: list.name,
			to: `/timeline/list/${list.id}`,
		})),
		(lists.length === 0 ? undefined : { type: 'divider' }),
		{
			type: 'link' as const,
			icon: 'ti ti-plus',
			text: i18n.ts.createNew,
			to: '/my/lists',
		},
	];
	os.popupMenu(items, ev.currentTarget ?? ev.target);
}

async function chooseAntenna(ev: MouseEvent): Promise<void> {
	const antennas = await antennasCache.fetch();
	const items: MenuItem[] = [
		...antennas.map(antenna => ({
			type: 'link' as const,
			text: antenna.name,
			indicate: antenna.hasUnreadNote,
			to: `/timeline/antenna/${antenna.id}`,
		})),
		(antennas.length === 0 ? undefined : { type: 'divider' }),
		{
			type: 'link' as const,
			icon: 'ti ti-plus',
			text: i18n.ts.createNew,
			to: '/my/antennas',
		},
	];
	os.popupMenu(items, ev.currentTarget ?? ev.target);
}

async function chooseChannel(ev: MouseEvent): Promise<void> {
	const channels = await misskeyApi('channels/my-favorites', {
		limit: 100,
	});
	const items: MenuItem[] = [
		...channels.map(channel => {
			const lastReadedAt = miLocalStorage.getItemAsJson(`channelLastReadedAt:${channel.id}`) ?? null;
			const hasUnreadNote = (lastReadedAt && channel.lastNotedAt) ? Date.parse(channel.lastNotedAt) > lastReadedAt : !!(!lastReadedAt && channel.lastNotedAt);

			return {
				type: 'link' as const,
				text: channel.name,
				indicate: hasUnreadNote,
				to: `/channels/${channel.id}`,
			};
		}),
		(channels.length === 0 ? undefined : { type: 'divider' }),
		{
			type: 'link' as const,
			icon: 'ti ti-plus',
			text: i18n.ts.createNew,
			to: '/channels',
		},
	];
	os.popupMenu(items, ev.currentTarget ?? ev.target);
}

function saveSrc(newSrc: 'home' | 'local' | 'social' | 'global' | `list:${string}`): void {
	const out = deepMerge({ src: newSrc }, defaultStore.state.tl);

	if (newSrc.startsWith('userList:')) {
		const id = newSrc.substring('userList:'.length);
		out.userList = defaultStore.reactiveState.pinnedUserLists.value.find(l => l.id === id) ?? null;
	}

	defaultStore.set('tl', out);
	if (['local', 'global'].includes(newSrc)) {
		srcWhenNotSignin.value = newSrc as 'local' | 'global';
	}
}

function saveTlFilter(key: keyof typeof defaultStore.state.tl.filter, newValue: boolean) {
	if (key !== 'withReplies' || $i) {
		const out = deepMerge({ filter: { [key]: newValue } }, defaultStore.state.tl);
		defaultStore.set('tl', out);
	}
}

async function timetravel(): Promise<void> {
	const { canceled, result: date } = await os.inputDate({
		title: i18n.ts.date,
	});
	if (canceled) return;

	tlComponent.value.timetravel(date);
}

function focus(): void {
	tlComponent.value.focus();
}

function closeTutorial(): void {
	if (!['home', 'local', 'social', 'global'].includes(src.value)) return;
	const before = defaultStore.state.timelineTutorials;
	before[src.value] = true;
	defaultStore.set('timelineTutorials', before);
}

const a1on2024 = computed(() => localDate.value.year === 2024 && localDate.value.month === 4 && localDate.value.day === 1);
const headerActions = computed(() => {
	const tmp = [
		{
			icon: 'ti ti-dots',
			text: i18n.ts.options,
			handler: (ev) => {
				os.popupMenu([{
					type: 'switch',
					text: i18n.ts.showRenotes,
					ref: withRenotes,
				}, src.value === 'local' || src.value === 'social' ? {
					type: 'switch',
					text: i18n.ts.showRepliesToOthersInTimeline,
					ref: withReplies,
					disabled: onlyFiles,
				} : undefined, {
					type: 'switch',
					text: i18n.ts.withSensitive,
					ref: withSensitive,
				}, {
					type: 'switch',
					text: i18n.ts.fileAttachedOnly,
					ref: onlyFiles,
					disabled: src.value === 'local' || src.value === 'social' ? withReplies : false,
				}], ev.currentTarget ?? ev.target);
			},
		},
	];
	if (deviceKind === 'desktop') {
		tmp.unshift({
			icon: 'ti ti-refresh',
			text: i18n.ts.reload,
			handler: (ev: Event) => {
				tlComponent.value?.reloadTimeline();
			},
		});
	}
	if (a1on2024.value) {
		tmp.unshift({
			icon: 'ti ti-mood-puzzled',
			text: i18n.ts.headlineMisskey,
			handler: (ev: Event) => {
				a1on2024enabled.value = !a1on2024enabled.value;
			},
		});
	}
	return tmp;
});

const headerTabs = computed(() => [...(defaultStore.reactiveState.pinnedUserLists.value.map(l => ({
	key: 'list:' + l.id,
	title: l.name,
	icon: 'ti ti-star',
	iconOnly: true,
}))), {
	key: 'home',
	title: i18n.ts._timelines.home,
	icon: 'ti ti-home',
	iconOnly: true,
}, ...(isLocalTimelineAvailable ? [{
	key: 'local',
	title: i18n.ts._timelines.local,
	icon: 'ti ti-planet',
	iconOnly: true,
}, {
	key: 'social',
	title: i18n.ts._timelines.social,
	icon: 'ti ti-universe',
	iconOnly: true,
}] : []), ...(isGlobalTimelineAvailable ? [{
	key: 'global',
	title: i18n.ts._timelines.global,
	icon: 'ti ti-whirl',
	iconOnly: true,
}] : []), {
	icon: 'ti ti-list',
	title: i18n.ts.lists,
	iconOnly: true,
	onClick: chooseList,
}, {
	icon: 'ti ti-antenna',
	title: i18n.ts.antennas,
	iconOnly: true,
	onClick: chooseAntenna,
}, {
	icon: 'ti ti-device-tv',
	title: i18n.ts.channel,
	iconOnly: true,
	onClick: chooseChannel,
}] as Tab[]);

const headerTabsWhenNotLogin = computed(() => [
	...(isLocalTimelineAvailable ? [{
		key: 'local',
		title: i18n.ts._timelines.local,
		icon: 'ti ti-planet',
		iconOnly: true,
	}] : []),
	...(isGlobalTimelineAvailable ? [{
		key: 'global',
		title: i18n.ts._timelines.global,
		icon: 'ti ti-whirl',
		iconOnly: true,
	}] : []),
] as Tab[]);

definePageMetadata(() => ({
	title: i18n.ts.timeline,
	icon: src.value === 'local' ? 'ti ti-planet' : src.value === 'social' ? 'ti ti-universe' : src.value === 'global' ? 'ti ti-whirl' : 'ti ti-home',
}));
</script>

<style lang="scss" module>
.new {
	position: sticky;
	top: calc(var(--stickyTop, 0px) + 16px);
	z-index: 1000;
	width: 100%;
	margin: calc(-0.675em - 8px) 0;

	&:first-child {
		margin-top: calc(-0.675em - 8px - var(--margin));
	}
}

.newButton {
	display: block;
	margin: var(--margin) auto 0 auto;
	padding: 8px 16px;
	border-radius: 32px;
}

.postForm {
	border-radius: var(--radius);
}

.tl {
	background: var(--bg);
	border-radius: var(--radius);
	overflow: clip;
}

.canvas {
	display: block;
	width: 100%;
	aspect-ratio: 16 / 9;
}

.canvasActionButton {
	position: absolute;
	top: 12px;
	right: 12px;
}
</style>
