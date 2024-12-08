<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.container">
	<div ref="dial" :class="$style.dial">
		<div :class="[$style.dialItem, { [$style.active]: visibility === 'public' }]">
			<i class="ti ti-world"></i>
		</div>
		<div :class="[$style.dialItem, { [$style.active]: visibility === 'home' }]">
			<i class="ti ti-home"></i>
		</div>
		<div :class="[$style.dialItem, { [$style.active]: visibility === 'followers' }]">
			<i class="ti ti-lock"></i>
		</div>
		<div :class="[$style.dialItem, { [$style.active]: visibility === 'specified' }]">
			<i class="ti ti-mail"></i>
		</div>
	</div>
	<div ref="grip" :class="$style.grip" @scroll.passive="scroll" @mousedown.passive="mousedown">
		<div v-for="_ in 11" :class="$style.gripItem"></div>
	</div>
</div>
</template>

<script lang="ts" setup>
import { onMounted, ref, shallowRef, watch } from 'vue';
import { defaultStore } from '@/store.js';

const dial = shallowRef<HTMLElement>();
const grip = shallowRef<HTMLElement>();
const y = ref<number | null>(null);
const visibilityChanging = ref(false);
const visibility = defaultStore.reactiveState.visibility;

onMounted(() => {
	grip.value!.scrollTop = visibility.value === 'public' ? 0 : visibility.value === 'home' ? 25 : visibility.value === 'followers' ? 50 : 75;
});

watch(visibility, (value) => {
	if (y.value !== null) return;
	if (visibilityChanging.value) {
		visibilityChanging.value = false;
		return;
	}
	grip.value!.scrollTop = value === 'public' ? 0 : value === 'home' ? 25 : value === 'followers' ? 50 : 75;
});

const scroll = (ev: Event) => {
	dial.value!.style.transform = `rotate(${(ev.target as HTMLElement).scrollTop * 0.48}deg)`;
	const scroll = Math.round((ev.target as HTMLElement).scrollTop / 25);
	const newVisibility = scroll <= 0 ? 'public' : scroll === 1 ? 'home' : scroll === 2 ? 'followers' : 'specified';
	if (visibility.value === newVisibility) return;
	visibilityChanging.value = true;
	defaultStore.set('visibility', newVisibility);
};

const mousedown = (ev: MouseEvent) => {
	if (ev.button !== 0) return;
	y.value = grip.value!.scrollTop + ev.screenY;
	grip.value!.style.setProperty('scroll-snap-type', 'none');
	grip.value!.style.setProperty('cursor', 'grabbing');
	document.body.style.setProperty('cursor', 'grabbing');
	document.body.addEventListener('mousemove', mousemove, { passive: true });
	document.body.addEventListener('mouseup', mouseup, { passive: true });
};

const mousemove = (ev: MouseEvent) => {
	grip.value!.scrollTop = y.value! - ev.screenY;
};

const mouseup = (ev: MouseEvent) => {
	if (ev.button !== 0) return;
	y.value = null;
	grip.value!.style.removeProperty('scroll-snap-type');
	grip.value!.style.removeProperty('cursor');
	document.body.style.removeProperty('cursor');
	document.body.removeEventListener('mousemove', mousemove);
	document.body.removeEventListener('mouseup', mouseup);
	grip.value!.scrollBy({ behavior: 'smooth' });
};
</script>

<style lang="scss" module>
.container {
	display: grid;
	width: 48px;
	height: 200px;
	align-items: center;
	align-content: center;

	&::after {
		display: block;
		content: '';
		width: 0;
		height: 0;
		grid-area: 1 / 1 / 2 / 2;
		z-index: 1;
		margin: 0 0 0 40px;
		border: solid 4px transparent;
		border-right-color: var(--MI_THEME-accent);
	}
}

.dial {
	display: grid;
	width: 254px;
	height: 254px;
	grid: 1fr / 1fr;
	grid-area: 1 / 1 / 2 / 2;
	background: var(--MI_THEME-panel);
	border: dashed 1px var(--MI_THEME-divider);
	border-radius: 128px;
	box-shadow: 0 0 8px #0003;
}

.dialItem {
	display: flex;
	width: 247px;
	height: 254px;
	align-items: center;
	grid-area: 1 / 1 / 2 / 2;
	padding: 0 0 0 7px;

	&:nth-child(1) {
		transform: rotate(0deg);
	}

	&:nth-child(2) {
		transform: rotate(-12deg);
	}

	&:nth-child(3) {
		transform: rotate(-24deg);
	}

	&:nth-child(4) {
		transform: rotate(-36deg);
	}

	&::after {
		display: block;
		content: '';
		width: 8px;
		margin: 0 0 0 8px;
		border-top: solid 1px var(--MI_THEME-divider);
		transition: border-top-color 0.2s;
	}

	& > :global(.ti) {
		opacity: 0.5;
		transition: opacity 0.2s;
	}

	&.active::after {
		border-top-color: var(--MI_THEME-accent);
	}

	&.active > :global(.ti) {
		opacity: 1;
	}
}

.grip {
	width: 256px;
	height: 200px;
	grid-area: 1 / 1 / 2 / 2;
	z-index: 2;
	overflow: clip auto;
	scrollbar-width: none;
	scroll-snap-type: y mandatory;
	cursor: grab;
	user-select: none;

	&::-webkit-scrollbar {
		display: none;
	}
}

.gripItem {
	width: 48px;
	height: 25px;
	scroll-snap-align: start;
}
</style>
