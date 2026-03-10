<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="hasDisconnected && prefer.s.serverDisconnectedBehavior === 'quiet'" :class="$style.root" class="_panel _shadow" @click="resetDisconnected">
	<div v-if="updateAvailability"><i class="ti ti-cloud-download"></i> {{ i18n.ts.misskeyUpdated }}</div>
	<div v-else><i class="ti ti-alert-triangle"></i> {{ i18n.ts.disconnectedFromServer }}</div>
	<div :class="$style.command" class="_buttons">
		<MkButton small primary @click="reload">{{ i18n.ts.reload }}</MkButton>
		<MkButton small>{{ i18n.ts.doNothing }}</MkButton>
	</div>
</div>
</template>

<script lang="ts" setup>
import { onUnmounted, ref } from 'vue';
import { useStream } from '@/stream.js';
import { i18n } from '@/i18n.js';
import MkButton from '@/components/MkButton.vue';
import * as os from '@/os.js';
import { prefer } from '@/preferences.js';
import { store } from '@/store.js';

interface UpdateAvailability {
	currentVersion: string;
	upcomingVersion: string;
}

const zIndex = os.claimZIndex('high');

const hasDisconnected = ref(false);

const updateAvailability = ref<UpdateAvailability | null>(null);

function onConnected() {
	hasDisconnected.value = false;
}

function onDisconnected() {
	hasDisconnected.value = true;
}

function onUpdateAvailable(value: UpdateAvailability) {
	updateAvailability.value = value;
}

function resetDisconnected() {
	hasDisconnected.value = false;
}

function reload() {
	window.location.reload();
}

if (store.s.realtimeMode) {
	useStream()
		.on('_connected_', onConnected)
		.on('_disconnected_', onDisconnected)
		.on('_update_available_', onUpdateAvailable);

	onUnmounted(() => {
		useStream()
			.off('_connected_', onConnected)
			.off('_disconnected_', onDisconnected)
			.off('_update_available_', onUpdateAvailable);
	});
}
</script>

<style lang="scss" module>
.root {
	position: fixed;
	z-index: v-bind(zIndex);
	bottom: calc(var(--MI-minBottomSpacing) + var(--MI-margin));
	right: var(--MI-margin);
	margin: 0;
	padding: 12px;
	font-size: 0.9em;
	max-width: 320px;
}

.command {
	margin-top: 8px;
}
</style>
