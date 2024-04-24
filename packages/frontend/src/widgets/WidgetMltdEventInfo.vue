<template>
<MkContainer :showHeader="widgetProps.showHeader" :naked="widgetProps.transparent">
	<template #icon><i class="ti ti-table-shortcut"></i></template>
	<template #header>{{ i18n.ts._widgets.mltdEventInfo }}</template>
	<template #func="{ buttonStyleClass }"><button class="_button" :class="buttonStyleClass" @click="configure()"><i class="ti ti-settings"></i></button></template>

	<MkLoading v-if="!events"/>
	<div v-else :class="$style.root">
		<div :class="$style.prefix">{{ namePrefix }}</div>
		<div v-if="nameSuffix === '～M@STERPIECE～'" :class="$style.name"><span style="color: #01a860;">～</span><span style="color: #9238be;">M</span><span style="color: #ffe43f;">@</span><span style="color: #fd99e1;">S</span><span style="color: #d3dde9;">T</span><span style="color: #b4e04b;">E</span><span style="color: #e22b30;">R</span><span style="color: #2743d2;">P</span><span style="color: #01adb9;">I</span><span style="color: #f39939;">E</span><span style="color: #ffe43f;">C</span><span style="color: #515558;">E</span><span style="color: #a6126a;">～</span></div>
		<div v-else :class="$style.name">{{ nameSuffix ?? i18n.ts.nothing }}</div>
		<template v-if="events[0]">
			<div v-if="events[0].schedule.beginAt && events[0].schedule.endAt" :class="$style.progress"><span :class="$style.pad">{{ progress ? '0'.repeat(7 - progress.length) : '---.---' }}</span>{{ progress }}<span :class="$style.unit">%</span></div>
			<div v-if="events[0].schedule.beginAt" :class="$style.time"><i class="ti ti-arrow-bar-right"></i><MkTime :time="events[0].schedule.beginAt" mode="absolute"/></div>
			<div v-if="events[0].schedule.boostBeginAt" :class="$style.time"><i class="ti ti-arrows-right"></i><MkTime :time="events[0].schedule.boostBeginAt" mode="absolute"/></div>
			<div v-if="events[0].schedule.endAt" :class="$style.time"><i class="ti ti-arrow-bar-to-right"></i><MkTime :time="events[0].schedule.endAt" mode="absolute"/></div>
			<div v-if="events[0].schedule.endAt" :class="$style.remaining">({{ remaining }})</div>
		</template>
		<div :class="$style.credit">Powered by matsurihi.me</div>
	</div>
</MkContainer>
</template>

<script lang="ts" setup>
import { computed, onUnmounted, ref } from 'vue';
import { WidgetComponentEmits, WidgetComponentExpose, WidgetComponentProps, useWidgetPropsManager } from './widget';
import MkContainer from '@/components/MkContainer.vue';
import { i18n } from '@/i18n';
import { GetFormResultType } from '@/scripts/form';
import { defaultIdlingRenderScheduler } from '@/scripts/idle-render.js';

const name = 'mltdEventInfo';

const widgetPropsDef = {
	showHeader: {
		type: 'boolean' as const,
		default: true,
	},
	transparent: {
		type: 'boolean' as const,
		default: false,
	},
};

type WidgetProps = GetFormResultType<typeof widgetPropsDef>;

const props = defineProps<WidgetComponentProps<WidgetProps>>();
const emit = defineEmits<WidgetComponentEmits<WidgetProps>>();

const { widgetProps, configure } = useWidgetPropsManager(name,
	widgetPropsDef,
	props,
	emit,
);

const progressFormat = new Intl.NumberFormat('en-US', {
	style: 'percent',
	minimumFractionDigits: 3,
	maximumFractionDigits: 3,
});
const relativeTimeFormat = new Intl.RelativeTimeFormat(navigator.language, {
	numeric: 'auto',
});
const events = ref<{
	id: number;
	name: string;
	schedule: {
		beginAt: Date;
		endAt: Date;
		boostBeginAt?: Date;
	};
}[] | null>();
let eventsETag = '';
let eventsTimeoutId: ReturnType<typeof setTimeout>;
const abortController = new AbortController();
const nameSplitIndex = computed(() => events.value?.[0]?.name.indexOf('～'));
const namePrefix = computed(() => ~nameSplitIndex.value ? events.value?.[0]?.name.slice(0, nameSplitIndex.value) : '');
const nameSuffix = computed(() => ~nameSplitIndex.value ? events.value?.[0]?.name.slice(nameSplitIndex.value) : events.value?.[0]?.name);
const progress = ref('');
const remaining = ref('');

async function fetchEvent(): Promise<void> {
	await fetch('https://api.matsurihi.me/api/mltd/v2/events?prettyPrint=false&at=now', {
		headers: {
			'If-None-Match': eventsETag,
		},
		mode: 'cors',
		signal: abortController.signal,
	}).then((response) => {
		if (!response.ok) {
			throw null; // eslint-disable-line no-throw-literal
		}
		eventsETag = response.headers.get('ETag') ?? '';
		return response.json() as Promise<{
			id: number;
			name: string;
			schedule: {
				beginAt: string;
				endAt: string;
				boostBeginAt: string | null;
			};
		}[]>;
	}).then((json) => {
		events.value = json.map((event) => ({
			id: event.id,
			name: event.name,
			schedule: {
				beginAt: new Date(event.schedule.beginAt),
				endAt: new Date(event.schedule.endAt),
				boostBeginAt: event.schedule.boostBeginAt ? new Date(event.schedule.boostBeginAt) : undefined,
			},
		}));
	}).finally(() => {
		const next = new Date();
		next.setHours(next.getHours() + 1);
		next.setMinutes(0);
		next.setSeconds(0);
		next.setMilliseconds(0);
		eventsTimeoutId = setTimeout(fetchEvent, next.getTime() - Date.now());
	});
}

function tick(): void {
	if (!events.value?.[0]) {
		return;
	}
	const now = new Date();
	progress.value = progressFormat.format(Math.min(1, (now.getTime() - events.value[0].schedule.beginAt.getTime()) / (events.value[0].schedule.endAt.getTime() - events.value[0].schedule.beginAt.getTime()))).slice(0, -1);
	let x = (events.value[0].schedule.endAt.getTime() - now.getTime()) / 1000;
	let unit: Intl.RelativeTimeFormatUnit = 'second';
	if (x > 300) {
		x /= 60;
		unit = 'minute';
	}
	if (x > 300) {
		x /= 60;
		unit = 'hour';
	}
	remaining.value = relativeTimeFormat.format(Math.floor(x), unit);
}

fetchEvent();
tick();
defaultIdlingRenderScheduler.add(tick);

onUnmounted(() => {
	clearTimeout(eventsTimeoutId);
	abortController.abort();
	defaultIdlingRenderScheduler.delete(tick);
});

defineExpose<WidgetComponentExpose>({
	name,
	configure,
	id: props.widget ? props.widget.id : null,
});
</script>

<style lang="scss" module>
.root {
	display: grid;
	grid: auto auto 1em 1em 1em auto / auto 1fr;
	padding: 1em 1em 0;
}

.prefix {
	grid-area: 1 / 1 / 2 / 3;
	font-size: 0.8em;
	line-height: 1.25;
}

.name {
	grid-area: 2 / 1 / 3 / 3;
	font-size: 1.6em;
	line-height: 1.25;
}

.time {
	grid-column: 1 / 2;
	font-size: 0.5em;
	line-height: 2;
	opacity: 0.875;

	& > i {
		padding: 0 0.5em;
	}
}

.progress {
	grid-area: 3 / 2 / 5 / 3;
	padding: 0 0 0 0.5em;
	font-size: 1.25em;
	line-height: 1.6;
	text-align: right;

	& > .unit {
		font-size: 0.5em;
	}
}

.remaining {
	grid-area: 5 / 2 / 6 / 3;
	padding: 0 0 0 1em;
	font-size: 0.8em;
	line-height: 1.25;
	font-variant-numeric: tabular-nums;
	text-align: right;
	opacity: 0.75;
}

.credit {
	padding: 0 1em 0 0;
	font-size: 0.6em;
	line-height: 3;
	opacity: 0.5;
}

.pad {
	opacity: 0.25;
}
</style>
