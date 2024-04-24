<template>
<MkContainer :showHeader="widgetProps.showHeader" :naked="widgetProps.transparent">
	<template #icon><i class="ti ti-table-shortcut"></i></template>
	<template #header>{{ i18n.ts._widgets.mltdEventBorder }}</template>
	<template #func="{ buttonStyleClass }"><button class="_button" :class="buttonStyleClass" @click="configure()"><i class="ti ti-settings"></i></button></template>

	<MkLoading v-if="!events"/>
	<div v-else :class="$style.root">
		<div :class="$style.title">{{ widgetProps.target }}<span v-if="widgetProps.offset" :class="$style.offset"> ({{ diffFormat.format(widgetProps.offset as number).startsWith('-') ? '' : '+' }}{{ diffFormat.format(widgetProps.offset as number) }})</span></div>
		<div :class="$style.updatedAt">{{ currentTime }}</div>
		<div :class="$style.currentPoint"><span :class="$style.pad">{{ currentPoint?.[1] || '---,---,---' }}</span><span>{{ currentPoint?.[2] }}</span></div>
		<div :class="$style.currentUnit">pt</div>
		<div v-if="previousDiff" :class="[$style.previousPoint, $style.row3]">{{ previousDiff?.startsWith('-') ? '' : '+' }}{{ previousDiff }}</div>
		<div v-if="previousTime" :class="[$style.previousUnit, $style.row3]">({{ previousTime }})</div>
		<div v-if="previousHourDiff" :class="[$style.previousPoint, $style.row4]">{{ previousHourDiff?.startsWith('-') ? '' : '+' }}{{ previousHourDiff }}</div>
		<div v-if="previousHourTime" :class="[$style.previousUnit, $style.row4]">({{ previousHourTime }})</div>
		<div v-if="previousDayDiff" :class="[$style.previousPoint, $style.row5]">{{ previousDayDiff?.startsWith('-') ? '' : '+' }}{{ previousDayDiff }}</div>
		<div v-if="previousDayTime" :class="[$style.previousUnit, $style.row5]">({{ previousDayTime }})</div>
		<div :class="$style.credit">Powered by matsurihi.me</div>
	</div>
</MkContainer>
</template>

<script lang="ts" setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { WidgetComponentEmits, WidgetComponentExpose, WidgetComponentProps, useWidgetPropsManager } from './widget';
import MkContainer from '@/components/MkContainer.vue';
import { i18n } from '@/i18n';
import { GetFormResultType } from '@/scripts/form';
/*
import * as sound from '@/scripts/sound';
 */

const name = 'mltdEventBorder';
const targets = {
	TPR: {
		type: 'eventPoint',
		ranks: 100,
	},
	PR: {
		type: 'eventPoint',
		ranks: 2500,
	},
	GR: {
		type: 'eventPoint',
		ranks: 5000,
	},
	SR: {
		type: 'eventPoint',
		ranks: 10000,
	},
	BR: {
		type: 'eventPoint',
		ranks: 25000,
	},
	TPM: {
		type: 'highScore',
		ranks: 100,
	},
	PM: {
		type: 'highScore',
		ranks: 2000,
	},
	GM: {
		type: 'highScore',
		ranks: 5000,
	},
	SM: {
		type: 'highScore',
		ranks: 10000,
	},
	BM: {
		type: 'highScore',
		ranks: 20000,
	},
	TPMT: {
		type: 'highScoreTotal',
		ranks: 100,
	},
	PMT: {
		type: 'highScoreTotal',
		ranks: 2000,
	},
	GMT: {
		type: 'highScoreTotal',
		ranks: 5000,
	},
	SMT: {
		type: 'highScoreTotal',
		ranks: 10000,
	},
	BMT: {
		type: 'highScoreTotal',
		ranks: 20000,
	},
	TPL: {
		type: 'loungePoint',
		ranks: 10,
	},
	PL: {
		type: 'loungePoint',
		ranks: 50,
	},
	GL: {
		type: 'loungePoint',
		ranks: 100,
	},
	SL: {
		type: 'loungePoint',
		ranks: 250,
	},
	BL: {
		type: 'loungePoint',
		ranks: 500,
	},
	天海春香TP: {
		type: 'idolPoint/1',
		ranks: 10,
	},
	天海春香P: {
		type: 'idolPoint/1',
		ranks: 100,
	},
	天海春香G: {
		type: 'idolPoint/1',
		ranks: 1000,
	},
	如月千早TP: {
		type: 'idolPoint/2',
		ranks: 10,
	},
	如月千早P: {
		type: 'idolPoint/2',
		ranks: 100,
	},
	如月千早G: {
		type: 'idolPoint/2',
		ranks: 1000,
	},
	星井美希TP: {
		type: 'idolPoint/3',
		ranks: 10,
	},
	星井美希P: {
		type: 'idolPoint/3',
		ranks: 100,
	},
	星井美希G: {
		type: 'idolPoint/3',
		ranks: 1000,
	},
	萩原雪歩TP: {
		type: 'idolPoint/4',
		ranks: 10,
	},
	萩原雪歩P: {
		type: 'idolPoint/4',
		ranks: 100,
	},
	萩原雪歩G: {
		type: 'idolPoint/4',
		ranks: 1000,
	},
	高槻やよいTP: {
		type: 'idolPoint/5',
		ranks: 10,
	},
	高槻やよいP: {
		type: 'idolPoint/5',
		ranks: 100,
	},
	高槻やよいG: {
		type: 'idolPoint/5',
		ranks: 1000,
	},
	菊地真TP: {
		type: 'idolPoint/6',
		ranks: 10,
	},
	菊地真P: {
		type: 'idolPoint/6',
		ranks: 100,
	},
	菊地真G: {
		type: 'idolPoint/6',
		ranks: 1000,
	},
	水瀬伊織TP: {
		type: 'idolPoint/7',
		ranks: 10,
	},
	水瀬伊織P: {
		type: 'idolPoint/7',
		ranks: 100,
	},
	水瀬伊織G: {
		type: 'idolPoint/7',
		ranks: 1000,
	},
	四条貴音TP: {
		type: 'idolPoint/8',
		ranks: 10,
	},
	四条貴音P: {
		type: 'idolPoint/8',
		ranks: 100,
	},
	四条貴音G: {
		type: 'idolPoint/8',
		ranks: 1000,
	},
	秋月律子TP: {
		type: 'idolPoint/9',
		ranks: 10,
	},
	秋月律子P: {
		type: 'idolPoint/9',
		ranks: 100,
	},
	秋月律子G: {
		type: 'idolPoint/9',
		ranks: 1000,
	},
	三浦あずさTP: {
		type: 'idolPoint/10',
		ranks: 10,
	},
	三浦あずさP: {
		type: 'idolPoint/10',
		ranks: 100,
	},
	三浦あずさG: {
		type: 'idolPoint/10',
		ranks: 1000,
	},
	双海亜美TP: {
		type: 'idolPoint/11',
		ranks: 10,
	},
	双海亜美P: {
		type: 'idolPoint/11',
		ranks: 100,
	},
	双海亜美G: {
		type: 'idolPoint/11',
		ranks: 1000,
	},
	双海真美TP: {
		type: 'idolPoint/12',
		ranks: 10,
	},
	双海真美P: {
		type: 'idolPoint/12',
		ranks: 100,
	},
	双海真美G: {
		type: 'idolPoint/12',
		ranks: 1000,
	},
	我那覇響TP: {
		type: 'idolPoint/13',
		ranks: 10,
	},
	我那覇響P: {
		type: 'idolPoint/13',
		ranks: 100,
	},
	我那覇響G: {
		type: 'idolPoint/13',
		ranks: 1000,
	},
	春日未来TP: {
		type: 'idolPoint/14',
		ranks: 10,
	},
	春日未来P: {
		type: 'idolPoint/14',
		ranks: 100,
	},
	春日未来G: {
		type: 'idolPoint/14',
		ranks: 1000,
	},
	最上静香TP: {
		type: 'idolPoint/15',
		ranks: 10,
	},
	最上静香P: {
		type: 'idolPoint/15',
		ranks: 100,
	},
	最上静香G: {
		type: 'idolPoint/15',
		ranks: 1000,
	},
	伊吹翼TP: {
		type: 'idolPoint/16',
		ranks: 10,
	},
	伊吹翼P: {
		type: 'idolPoint/16',
		ranks: 100,
	},
	伊吹翼G: {
		type: 'idolPoint/16',
		ranks: 1000,
	},
	田中琴葉TP: {
		type: 'idolPoint/17',
		ranks: 10,
	},
	田中琴葉P: {
		type: 'idolPoint/17',
		ranks: 100,
	},
	田中琴葉G: {
		type: 'idolPoint/17',
		ranks: 1000,
	},
	島原エレナTP: {
		type: 'idolPoint/18',
		ranks: 10,
	},
	島原エレナP: {
		type: 'idolPoint/18',
		ranks: 100,
	},
	島原エレナG: {
		type: 'idolPoint/18',
		ranks: 1000,
	},
	佐竹美奈子TP: {
		type: 'idolPoint/19',
		ranks: 10,
	},
	佐竹美奈子P: {
		type: 'idolPoint/19',
		ranks: 100,
	},
	佐竹美奈子G: {
		type: 'idolPoint/19',
		ranks: 1000,
	},
	所恵美TP: {
		type: 'idolPoint/20',
		ranks: 10,
	},
	所恵美P: {
		type: 'idolPoint/20',
		ranks: 100,
	},
	所恵美G: {
		type: 'idolPoint/20',
		ranks: 1000,
	},
	徳川まつりTP: {
		type: 'idolPoint/21',
		ranks: 10,
	},
	徳川まつりP: {
		type: 'idolPoint/21',
		ranks: 100,
	},
	徳川まつりG: {
		type: 'idolPoint/21',
		ranks: 1000,
	},
	箱崎星梨花TP: {
		type: 'idolPoint/22',
		ranks: 10,
	},
	箱崎星梨花P: {
		type: 'idolPoint/22',
		ranks: 100,
	},
	箱崎星梨花G: {
		type: 'idolPoint/22',
		ranks: 1000,
	},
	野々原茜TP: {
		type: 'idolPoint/23',
		ranks: 10,
	},
	野々原茜P: {
		type: 'idolPoint/23',
		ranks: 100,
	},
	野々原茜G: {
		type: 'idolPoint/23',
		ranks: 1000,
	},
	望月杏奈TP: {
		type: 'idolPoint/24',
		ranks: 10,
	},
	望月杏奈P: {
		type: 'idolPoint/24',
		ranks: 100,
	},
	望月杏奈G: {
		type: 'idolPoint/24',
		ranks: 1000,
	},
	ロコTP: {
		type: 'idolPoint/25',
		ranks: 10,
	},
	ロコP: {
		type: 'idolPoint/25',
		ranks: 100,
	},
	ロコG: {
		type: 'idolPoint/25',
		ranks: 1000,
	},
	七尾百合子TP: {
		type: 'idolPoint/26',
		ranks: 10,
	},
	七尾百合子P: {
		type: 'idolPoint/26',
		ranks: 100,
	},
	七尾百合子G: {
		type: 'idolPoint/26',
		ranks: 1000,
	},
	高山紗代子TP: {
		type: 'idolPoint/27',
		ranks: 10,
	},
	高山紗代子P: {
		type: 'idolPoint/27',
		ranks: 100,
	},
	高山紗代子G: {
		type: 'idolPoint/27',
		ranks: 1000,
	},
	松田亜利沙TP: {
		type: 'idolPoint/28',
		ranks: 10,
	},
	松田亜利沙P: {
		type: 'idolPoint/28',
		ranks: 100,
	},
	松田亜利沙G: {
		type: 'idolPoint/28',
		ranks: 1000,
	},
	高坂海美TP: {
		type: 'idolPoint/29',
		ranks: 10,
	},
	高坂海美P: {
		type: 'idolPoint/29',
		ranks: 100,
	},
	高坂海美G: {
		type: 'idolPoint/29',
		ranks: 1000,
	},
	中谷育TP: {
		type: 'idolPoint/30',
		ranks: 10,
	},
	中谷育P: {
		type: 'idolPoint/30',
		ranks: 100,
	},
	中谷育G: {
		type: 'idolPoint/30',
		ranks: 1000,
	},
	天空橋朋花TP: {
		type: 'idolPoint/31',
		ranks: 10,
	},
	天空橋朋花P: {
		type: 'idolPoint/31',
		ranks: 100,
	},
	天空橋朋花G: {
		type: 'idolPoint/31',
		ranks: 1000,
	},
	エミリーTP: {
		type: 'idolPoint/32',
		ranks: 10,
	},
	エミリーP: {
		type: 'idolPoint/32',
		ranks: 100,
	},
	エミリーG: {
		type: 'idolPoint/32',
		ranks: 1000,
	},
	北沢志保TP: {
		type: 'idolPoint/33',
		ranks: 10,
	},
	北沢志保P: {
		type: 'idolPoint/33',
		ranks: 100,
	},
	北沢志保G: {
		type: 'idolPoint/33',
		ranks: 1000,
	},
	舞浜歩TP: {
		type: 'idolPoint/34',
		ranks: 10,
	},
	舞浜歩P: {
		type: 'idolPoint/34',
		ranks: 100,
	},
	舞浜歩G: {
		type: 'idolPoint/34',
		ranks: 1000,
	},
	木下ひなたTP: {
		type: 'idolPoint/35',
		ranks: 10,
	},
	木下ひなたP: {
		type: 'idolPoint/35',
		ranks: 100,
	},
	木下ひなたG: {
		type: 'idolPoint/35',
		ranks: 1000,
	},
	矢吹可奈TP: {
		type: 'idolPoint/36',
		ranks: 10,
	},
	矢吹可奈P: {
		type: 'idolPoint/36',
		ranks: 100,
	},
	矢吹可奈G: {
		type: 'idolPoint/36',
		ranks: 1000,
	},
	横山奈緒TP: {
		type: 'idolPoint/37',
		ranks: 10,
	},
	横山奈緒P: {
		type: 'idolPoint/37',
		ranks: 100,
	},
	横山奈緒G: {
		type: 'idolPoint/37',
		ranks: 1000,
	},
	二階堂千鶴TP: {
		type: 'idolPoint/38',
		ranks: 10,
	},
	二階堂千鶴P: {
		type: 'idolPoint/38',
		ranks: 100,
	},
	二階堂千鶴G: {
		type: 'idolPoint/38',
		ranks: 1000,
	},
	馬場このみTP: {
		type: 'idolPoint/39',
		ranks: 10,
	},
	馬場このみP: {
		type: 'idolPoint/39',
		ranks: 100,
	},
	馬場このみG: {
		type: 'idolPoint/39',
		ranks: 1000,
	},
	大神環TP: {
		type: 'idolPoint/40',
		ranks: 10,
	},
	大神環P: {
		type: 'idolPoint/40',
		ranks: 100,
	},
	大神環G: {
		type: 'idolPoint/40',
		ranks: 1000,
	},
	豊川風花TP: {
		type: 'idolPoint/41',
		ranks: 10,
	},
	豊川風花P: {
		type: 'idolPoint/41',
		ranks: 100,
	},
	豊川風花G: {
		type: 'idolPoint/41',
		ranks: 1000,
	},
	宮尾美也TP: {
		type: 'idolPoint/42',
		ranks: 10,
	},
	宮尾美也P: {
		type: 'idolPoint/42',
		ranks: 100,
	},
	宮尾美也G: {
		type: 'idolPoint/42',
		ranks: 1000,
	},
	福田のり子TP: {
		type: 'idolPoint/43',
		ranks: 10,
	},
	福田のり子P: {
		type: 'idolPoint/43',
		ranks: 100,
	},
	福田のり子G: {
		type: 'idolPoint/43',
		ranks: 1000,
	},
	真壁瑞希TP: {
		type: 'idolPoint/44',
		ranks: 10,
	},
	真壁瑞希P: {
		type: 'idolPoint/44',
		ranks: 100,
	},
	真壁瑞希G: {
		type: 'idolPoint/44',
		ranks: 1000,
	},
	篠宮可憐TP: {
		type: 'idolPoint/45',
		ranks: 10,
	},
	篠宮可憐P: {
		type: 'idolPoint/45',
		ranks: 100,
	},
	篠宮可憐G: {
		type: 'idolPoint/45',
		ranks: 1000,
	},
	百瀬莉緒TP: {
		type: 'idolPoint/46',
		ranks: 10,
	},
	百瀬莉緒P: {
		type: 'idolPoint/46',
		ranks: 100,
	},
	百瀬莉緒G: {
		type: 'idolPoint/46',
		ranks: 1000,
	},
	永吉昴TP: {
		type: 'idolPoint/47',
		ranks: 10,
	},
	永吉昴P: {
		type: 'idolPoint/47',
		ranks: 100,
	},
	永吉昴G: {
		type: 'idolPoint/47',
		ranks: 1000,
	},
	北上麗花TP: {
		type: 'idolPoint/48',
		ranks: 10,
	},
	北上麗花P: {
		type: 'idolPoint/48',
		ranks: 100,
	},
	北上麗花G: {
		type: 'idolPoint/48',
		ranks: 1000,
	},
	周防桃子TP: {
		type: 'idolPoint/49',
		ranks: 10,
	},
	周防桃子P: {
		type: 'idolPoint/49',
		ranks: 100,
	},
	周防桃子G: {
		type: 'idolPoint/49',
		ranks: 1000,
	},
	ジュリアTP: {
		type: 'idolPoint/50',
		ranks: 10,
	},
	ジュリアP: {
		type: 'idolPoint/50',
		ranks: 100,
	},
	ジュリアG: {
		type: 'idolPoint/50',
		ranks: 1000,
	},
	白石紬TP: {
		type: 'idolPoint/51',
		ranks: 10,
	},
	白石紬P: {
		type: 'idolPoint/51',
		ranks: 100,
	},
	白石紬G: {
		type: 'idolPoint/51',
		ranks: 1000,
	},
	桜守歌織TP: {
		type: 'idolPoint/52',
		ranks: 10,
	},
	桜守歌織P: {
		type: 'idolPoint/52',
		ranks: 100,
	},
	桜守歌織G: {
		type: 'idolPoint/52',
		ranks: 1000,
	},
} as const;

const widgetPropsDef = {
	showHeader: {
		type: 'boolean' as const,
		default: true,
	},
	transparent: {
		type: 'boolean' as const,
		default: false,
	},
	sound: {
		type: 'boolean' as const,
		default: false,
	},
	target: {
		type: 'enum' as const,
		default: 'PR' as const,
		enum: Object.keys(targets).map((key) => ({
			label: key,
			value: key,
		})) as unknown as string[],
	},
	offset: {
		type: 'number' as const,
		default: 0 as const,
		min: -1e6 as const,
		max: 1e6 as const,
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
/*
const popo = sound.setVolume(sound.getAudio('syuilo/popo'), 1);
 */
const pointFormat = new Intl.NumberFormat('en-US', {
	style: 'decimal',
	minimumFractionDigits: 0,
	maximumFractionDigits: 0,
	minimumIntegerDigits: 9,
});
const diffFormat = new Intl.NumberFormat('en-US', {
	style: 'decimal',
	minimumFractionDigits: 0,
	maximumFractionDigits: 0,
});
const absoluteTimeFormat = new Intl.DateTimeFormat('en-US', {
	hour: 'numeric',
	minute: 'numeric',
	hour12: false,
});
const relativeTimeFormat = new Intl.RelativeTimeFormat(navigator.language, {
	style: 'short',
	numeric: 'auto',
});

const events = ref<{
	id: number;
}[] | null>();
let eventsETag = '';
let eventsTimeoutId: ReturnType<typeof setTimeout>;
const border = ref<{
	data: {
		score: number;
		aggregatedAt: Date;
	}[];
}[] | null>();
let borderETag = '';
let borderTimeoutId: ReturnType<typeof setTimeout>;
const abortController = new AbortController();
const current = computed(() => {
	if (!border.value?.[0]?.data[0]) {
		return null;
	}
	const data = border.value[0].data;
	return data[data.length - 1];
});
const currentPoint = computed(() => {
	if (!current.value) {
		return null;
	}
	return pointFormat.format(current.value.score).match(/^([0,]*)(.*)$/);
});
const currentTime = computed(() => {
	if (!current.value) {
		return null;
	}
	return absoluteTimeFormat.format(current.value.aggregatedAt);
});
const previous = computed(() => {
	if (!border.value?.[0]?.data[1]) {
		return null;
	}
	const data = border.value[0].data;
	return data[data.length - 2];
});
const previousDiff = computed(() => {
	if (!current.value || !previous.value) {
		return null;
	}
	return diffFormat.format(current.value.score - previous.value.score);
});
const previousTime = computed(() => {
	if (!current.value || !previous.value) {
		return null;
	}
	return relativeTimeFormat.format((previous.value.aggregatedAt.getTime() - current.value.aggregatedAt.getTime()) / 60000, 'minute');
});
const previousHour = computed(() => {
	if (!border.value?.[0]?.data[1]) {
		return null;
	}
	const data = border.value[0].data;
	const lastHour = new Date(data[data.length - 1].aggregatedAt);
	lastHour.setHours(lastHour.getHours() - 1);
	return data.findLast((d) => d.aggregatedAt <= lastHour) ?? null;
});
const previousHourDiff = computed(() => {
	if (!current.value || !previousHour.value) {
		return null;
	}
	return diffFormat.format(current.value.score - previousHour.value.score);
});
const previousHourTime = computed(() => {
	if (!current.value || !previousHour.value) {
		return null;
	}
	return relativeTimeFormat.format((previousHour.value.aggregatedAt.getTime() - current.value.aggregatedAt.getTime()) / 60000, 'minute');
});
const previousDay = computed(() => {
	if (!border.value?.[0]?.data[1]) {
		return null;
	}
	const data = border.value[0].data;
	const yesterday = new Date(data[data.length - 1].aggregatedAt);
	yesterday.setDate(yesterday.getDate() - 1);
	return data.findLast((d) => d.aggregatedAt <= yesterday) ?? null;
});
const previousDayDiff = computed(() => {
	if (!current.value || !previousDay.value) {
		return null;
	}
	return diffFormat.format(current.value.score - previousDay.value.score);
});
const previousDayTime = computed(() => {
	if (!current.value || !previousDay.value) {
		return null;
	}
	return relativeTimeFormat.format((previousDay.value.aggregatedAt.getTime() - current.value.aggregatedAt.getTime()) / 3600000, 'hour');
});

async function fetchEvent(initial = false): Promise<void> {
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
		}[]>;
	}).then((json) => {
		events.value = json.map((event) => ({
			id: event.id,
		}));
	}).finally(() => {
		const next = new Date();
		next.setHours(next.getHours() + 1);
		next.setMinutes(0);
		next.setSeconds(0);
		next.setMilliseconds(0);
		eventsTimeoutId = setTimeout(fetchEvent, next.getTime() - Date.now(), false);
		if (initial) {
			fetchBorder(true);
		}
	});
}

async function fetchBorder(initial = false): Promise<void> {
	const event = events.value?.[0];
	if (!event) {
		clearTimeout(borderTimeoutId);
		const next = new Date();
		next.setHours(next.getHours() + 1);
		next.setMinutes(0);
		next.setSeconds(0);
		next.setMilliseconds(0);
		borderTimeoutId = setTimeout(fetchBorder, next.getTime() - Date.now(), true);
		return;
	}
	const target = targets[widgetProps.target as keyof typeof targets];
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	await fetch(`https://api.matsurihi.me/api/mltd/v2/events/${event.id}/rankings/${target.type}/logs/${Math.max(1, target.ranks + (widgetProps.offset as number))}?prettyPrint=false&all=true`, {
		headers: {
			'If-None-Match': borderETag,
		},
		signal: abortController.signal,
	}).then((response) => {
		if (!response.ok) {
			throw null; // eslint-disable-line no-throw-literal
		}
		borderETag = response.headers.get('ETag') ?? '';
		return response.json() as Promise<{
			data: {
				score: number;
				aggregatedAt: string;
			}[];
		}[]>;
	}).then((json) => {
		border.value = json.map((rank) => ({
			data: rank.data.map((data) => ({
				score: data.score,
				aggregatedAt: new Date(data.aggregatedAt),
			})),
		}));
		/*
		if (!initial && widgetProps.sound && popo.paused) {
			popo.play();
		}
		 */
	}).finally(() => {
		const next = new Date();
		next.setSeconds(10 * -~(next.getSeconds() / 10));
		next.setMilliseconds(0);
		borderTimeoutId = setTimeout(fetchBorder, next.getTime() - Date.now(), false);
	});
}

watch(() => widgetProps.target, () => {
	fetchEvent(true);
}, {
	immediate: true,
});

onUnmounted(() => {
	clearTimeout(eventsTimeoutId);
	clearTimeout(borderTimeoutId);
	abortController.abort();
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
	grid: 2em 3em 1.5em 1.5em 1.5em / 1fr auto auto;
	padding: 1em 1em 1em 0;
}

.title {
	grid-area: 1 / 1 / 2 / 3;
	padding: 0 0 0 0.8em;
	font-size: 1.25em;
	line-height: 1.6;
	font-weight: bold;

	& > .offset {
		opacity: 0.5;
	}
}

.updatedAt {
	grid-area: 1 / 3 / 2 / 4;
	font-size: 1.25em;
	line-height: 1.6;
	text-align: right;
}

.currentPoint {
	grid-area: 2 / 1 / 3 / 3;
	justify-self: end;
	font-size: 2.4em;
	line-height: 1.25;
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}

.currentUnit {
	grid-area: 2 / 3 / 3 / 4;
	padding: 0 0 0 0.25em;
	font-size: 1.2em;
	line-height: 3;
}

.previousPoint {
	grid-column: 2 / 3;
	font-size: 1.2em;
	line-height: 1.25;
	font-variant-numeric: tabular-nums;
	text-align: right;

	&.row3 {
		grid-row: 3 / 4;
	}

	&.row4 {
		grid-row: 4 / 5;
	}

	&.row5 {
		grid-row: 5 / 6;
	}
}

.previousUnit {
	grid-column: 3 / 4;
	padding: 0 0 0 0.5em;
	font-size: 0.6em;
	line-height: 2.4;
	opacity: 0.75;

	&.row3 {
		grid-row: 3 / 4;
	}

	&.row4 {
		grid-row: 4 / 5;
	}

	&.row5 {
		grid-row: 5 / 6;
	}
}

.credit {
	grid-area: 5 / 1 / 6 / 2;
	align-self: end;
	padding: 0 1em 0 1.5em;
	font-size: 0.6em;
	opacity: 0.5;
}

.pad {
	opacity: 0.25;
}
</style>
