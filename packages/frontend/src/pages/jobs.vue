<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkStickyContainer>
	<template #header><MkPageHeader :actions="headerActions" :tabs="headerTabs"/></template>
	<MkSpacer :contentMax="600" :marginMin="16" class="_gaps_s">
		<div v-for="job in jobs" :key="job.id">
			<div :class="$style.job" class="_panel">
				<div :class="$style.name">{{ job.name }}</div>
				<MkTime :class="$style.timestamp" :time="job.timestamp"/>
				<XPie :class="$style.progress" :value="job.progress / 100" class="_pie"/>
			</div>
		</div>
	</MkSpacer>
</MkStickyContainer>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/scripts/misskey-api.js';
import { definePageMetadata } from '@/scripts/page-metadata.js';
import XPie from '@/widgets/server-metric/pie.vue';

const intervalId = ref<number | null>(null);
const jobs = ref([]);

let abortController = new AbortController();

onMounted(() => {
	intervalId.value = setInterval(() => {
		abortController.abort();
		abortController = new AbortController();
		misskeyApi('i/jobs', {}, undefined, abortController.signal).then((res: any) => {
			jobs.value = res;
		});
	}, 1000);
});

onBeforeUnmount(() => {
	clearInterval(intervalId.value);
});

const headerActions = computed(() => []);

const headerTabs = computed(() => []);

definePageMetadata({
	title: i18n.ts.jobQueue,
	icon: 'ti ti-clock-play',
});
</script>

<style lang="scss" module>
.job {
	display: grid;
	grid: 6fr 4fr / 1fr auto;
	gap: var(--MI-margin);
	padding: var(--MI-margin);
	line-height: 1.5;
}

.name {
	grid-area: 1 / 1 / 2 / 2;
	font-size: 1.2em;
}

.timestamp {
	grid-area: 2 / 1 / 3 / 2;
	font-size: 0.8em;
	opacity: 0.5;
}

.progress {
	grid-area: 1 / 2 / 3 / 3;
}
</style>
