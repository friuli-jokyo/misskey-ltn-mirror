<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<SearchMarker path="/settings/profiles" :label="i18n.ts._preferencesProfile.manageProfiles" :keywords="['profile', 'settings', 'preferences', 'manage']" icon="ti ti-settings-cog">
	<div class="_gaps">
		<MkButton primary @click="create">
			<i class="ti ti-plus"></i>{{ i18n.ts.create }}
		</MkButton>
		<MkFolder v-for="backup in backups" :key="backup.name">
			<template #label>{{ backup.name }}</template>
			<div class="_gaps_s">
				<MkButton primary @click="load(backup)">{{ i18n.ts.apply }}</MkButton>
				<MkButton danger @click="del(backup)">{{ i18n.ts.delete }}</MkButton>
			</div>
		</MkFolder>
	</div>
</SearchMarker>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import MkButton from '@/components/MkButton.vue';
import MkFolder from '@/components/MkFolder.vue';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import { deleteCloudBackup, listCloudBackups } from '@/preferences/utility.js';
import * as os from '@/os.js';
import { prefer } from '@/preferences.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { miLocalStorage } from '@/local-storage.js';
import { store } from '@/store.js';
import { unisonReload } from '@/utility/unison-reload.js';

const backups = await listCloudBackups();

async function create(): Promise<void> {
	const { canceled, result: name } = await os.inputText({
		title: i18n.ts._preferencesProfile.profileName,
		text: i18n.ts._preferencesProfile.profileNameDescription + '\n' + i18n.ts._preferencesProfile.profileNameDescription2,
	});
	if (canceled || name == null || name.trim() === '') return;

	// Check if profile with same name already exists
	if (backups.some(b => b.name === name)) {
		await os.alert({
			type: 'warning',
			text: i18n.ts._preferencesProfile.profileNameAlreadyExists,
		});
		return;
	}

	// Create empty profile with the given name
	const newProfile = {
		...prefer.profile,
		name,
	};

	await misskeyApi('i/registry/set', {
		scope: ['client', 'preferences', 'backups'],
		key: name,
		value: newProfile,
	});

	// Refresh the list
	backups.push({ name });

	os.success();
}

async function load(backup: { name: string }): Promise<void> {
	const { canceled } = await os.confirm({
		type: 'question',
		text: i18n.tsx._preferencesProfile.confirmLoadProfile({ name: backup.name }),
	});
	if (canceled) return;

	const profile = await misskeyApi('i/registry/get', {
		scope: ['client', 'preferences', 'backups'],
		key: backup.name,
	});

	miLocalStorage.setItem('preferences', JSON.stringify(profile));
	miLocalStorage.setItem('hidePreferencesRestoreSuggestion', 'true');
	store.set('enablePreferencesAutoCloudBackup', true);
	unisonReload();
}

function del(backup: { name: string }): void {
	deleteCloudBackup(backup.name);
}

const headerActions = computed(() => []);

const headerTabs = computed(() => []);

definePage(() => ({
	title: i18n.ts._preferencesProfile.manageProfiles,
	icon: 'ti ti-settings-cog',
}));
</script>

<style lang="scss" module>
</style>
