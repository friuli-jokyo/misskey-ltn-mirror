<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkModal v-if="showAsModal" ref="modal" preferType="dialog" :zPriority="'middle'" @click="modal?.close()" @closed="emit('closed')">
	<div :class="$style.root">
		<div :class="$style.title"><MkSparkle>{{ i18n.ts.misskeyUpdated }}</MkSparkle></div>
		<div :class="$style.version">✨{{ version }}🚀</div>
		<div v-if="isBeta" :class="$style.beta">{{ i18n.ts.thankYouForTestingBeta }}</div>
		<MkButton full @click="whatIsNew">{{ i18n.ts.whatIsNew }}</MkButton>
		<MkButton :class="$style.gotIt" primary full @click="modal?.close()">{{ i18n.ts.gotIt }}</MkButton>
	</div>
</MkModal>
<div v-else :class="[$style.container, { [$style.read]: read }]">
	<div :class="$style.root">
		<div :class="$style.title"><MkSparkle>{{ i18n.ts.misskeyUpdated }}</MkSparkle></div>
		<div :class="$style.version">✨{{ version }}🚀</div>
		<div v-if="isBeta" :class="$style.beta">{{ i18n.ts.thankYouForTestingBeta }}</div>
		<MkButton @click="whatIsNew">{{ i18n.ts.whatIsNew }}</MkButton>
		<MkButton :class="$style.gotIt" primary @click="read = true">{{ i18n.ts.gotIt }}</MkButton>
	</div>
</div>
</template>

<script lang="ts" setup>
import { onMounted, ref, useTemplateRef } from 'vue';
import { version } from '@@/js/config.js';
import MkModal from '@/components/MkModal.vue';
import MkButton from '@/components/MkButton.vue';
import MkSparkle from '@/components/MkSparkle.vue';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { confetti } from '@/utility/confetti.js';

const props = defineProps<{
	showAsModal: boolean;
}>();

const modal = useTemplateRef('modal');
const zIndex = os.claimZIndex('high');
const read = ref(false);

const emit = defineEmits<{
	(ev: 'closed'): void;
}>();

const isBeta = version.includes('-beta') || version.includes('-alpha') || version.includes('-rc');

function whatIsNew() {
	modal.value?.close();
	window.open(`https://misskey-hub.net/docs/releases/#_${version.replace(/\./g, '')}`, '_blank');
}

onMounted(() => {
	if (props.showAsModal) {
		confetti({
			duration: 1000 * 3,
		});
	}
});
</script>

<style lang="scss" module>
.container {
	position: fixed;
	z-index: v-bind(zIndex);
	bottom: calc(var(--MI-minBottomSpacing) + var(--MI-margin));
	right: var(--MI-margin);
	margin: 0;

	&.read {
		display: none;
	}
}

.root {
	margin: auto;
	position: relative;
	padding: 32px;
	min-width: 320px;
	max-width: 480px;
	box-sizing: border-box;
	text-align: center;
	background: var(--MI_THEME-panel);
	border-radius: var(--MI-radius);
}

.title {
	font-weight: bold;
}

.version {
	margin: 1em 0;
}

.beta {
	margin: 1em 0;
}

.gotIt {
	margin: 8px 0 0 0;
}
</style>
