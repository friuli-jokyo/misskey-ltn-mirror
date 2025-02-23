<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkStickyContainer>
	<template #header><MkPageHeader v-model:tab="tab" :tabs="headerTabs" :actions="headerActions"/></template>
	<MkSpacer v-if="error != null" :contentMax="1200">
		<div :class="$style.root">
			<img :class="$style.img" :src="serverErrorImageUrl" class="_ghost"/>
			<p :class="$style.text">
				<i class="ti ti-alert-triangle"></i>
				{{ error }}
			</p>
		</div>
	</MkSpacer>
	<MkSpacer v-else-if="tab === 'users'" :contentMax="1200">
		<div class="_gaps_s">
			<div v-if="role">{{ role.description }}</div>
			<MkUserList v-if="visible" :pagination="users" :extractor="(item) => item.user"/>
			<div v-else-if="!visible" class="_fullinfo">
				<img :src="infoImageUrl" class="_ghost"/>
				<div>{{ i18n.ts.nothing }}</div>
			</div>
		</div>
	</MkSpacer>
	<MkSpacer v-else-if="tab === 'timeline'" :contentMax="700">
		<MkTimeline v-if="visible" ref="timeline" src="role" :role="props.roleId"/>
		<div v-else-if="!visible" class="_fullinfo">
			<img :src="infoImageUrl" class="_ghost"/>
			<div>{{ i18n.ts.nothing }}</div>
		</div>
	</MkSpacer>
</MkStickyContainer>
</template>

<script lang="ts" setup>
import { computed, watch, ref } from 'vue';
import * as Misskey from 'misskey-js';
import { $i } from '@/account.js';
import { misskeyApi } from '@/scripts/misskey-api.js';
import MkUserList from '@/components/MkUserList.vue';
import { definePageMetadata } from '@/scripts/page-metadata.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import MkTimeline from '@/components/MkTimeline.vue';
import { instanceName } from '@@/js/config.js';
import { serverErrorImageUrl, infoImageUrl } from '@/instance.js';

const props = withDefaults(defineProps<{
	roleId: string;
	initialTab?: string;
}>(), {
	initialTab: 'users',
});

// eslint-disable-next-line vue/no-setup-props-reactivity-loss
const tab = ref(props.initialTab);
const role = ref<Misskey.entities.Role | null>(null);
const error = ref<string | null>(null);
const visible = ref(false);

watch(() => props.roleId, () => {
	misskeyApi('roles/show', {
		roleId: props.roleId,
	}).then(res => {
		role.value = res;
		error.value = null;
		visible.value = res.isExplorable && res.isPublic;
	}).catch((err) => {
		if (err.code === 'NO_SUCH_ROLE') {
			error.value = i18n.ts.noRole;
		} else {
			error.value = i18n.ts.somethingHappened;
		}
	});
}, { immediate: true });

const users = computed(() => ({
	endpoint: 'roles/users' as const,
	limit: 30,
	params: {
		roleId: props.roleId,
	},
}));

const headerActions = computed(() =>
	role.value?.target === 'manual'
		? $i?.policies.selfAssignability?.some(([t, u]) => u && role.value.tags.includes(t))
			? [
					{
						icon: 'ti ti-user-minus',
						text: i18n.ts.unassign,
						handler: unassign,
					},
					{
						icon: 'ti ti-user-plus',
						text: i18n.ts.assign,
						handler: assign,
					},
				]
			: $i?.policies.selfAssignability?.some(([t, u]) => role.value.tags.includes(t))
				? [
						{
							icon: 'ti ti-user-plus',
							text: i18n.ts.assign,
							handler: assignIndefinetly,
						},
					]
				: []
		: []);

async function assign() {
	const { canceled, result: period } = await os.select({
		title: i18n.ts.period + ': ' + role.value.name,
		items: [{
			value: 'indefinitely', text: i18n.ts.indefinitely,
		}, {
			value: 'oneHour', text: i18n.ts.oneHour,
		}, {
			value: 'oneDay', text: i18n.ts.oneDay,
		}, {
			value: 'oneWeek', text: i18n.ts.oneWeek,
		}, {
			value: 'oneMonth', text: i18n.ts.oneMonth,
		}],
		default: 'indefinitely',
	});
	if (canceled) return;

	const expiresAt = period === 'indefinitely' ? null
		: period === 'oneHour' ? Date.now() + (1000 * 60 * 60)
		: period === 'oneDay' ? Date.now() + (1000 * 60 * 60 * 24)
		: period === 'oneWeek' ? Date.now() + (1000 * 60 * 60 * 24 * 7)
		: period === 'oneMonth' ? Date.now() + (1000 * 60 * 60 * 24 * 30)
		: null;

	os.apiWithDialog('admin/roles/assign', { roleId: role.value.id, userId: $i.id, expiresAt });
}

async function assignIndefinetly() {
	const { canceled } = await os.confirm({
		type: 'warning',
		title: i18n.ts.areYouSure,
	});
	if (canceled) return;

	os.apiWithDialog('admin/roles/assign', { roleId: role.value.id, userId: $i.id });
}

async function unassign() {
	const { canceled } = await os.confirm({
		type: 'warning',
		title: i18n.ts.areYouSure,
	});
	if (canceled) return;

	os.apiWithDialog('admin/roles/unassign', { roleId: role.value.id, userId: $i.id });
}

const headerTabs = computed(() => [{
	key: 'users',
	icon: 'ti ti-users',
	title: i18n.ts.users,
}, {
	key: 'timeline',
	icon: 'ti ti-pencil',
	title: i18n.ts.timeline,
}]);

definePageMetadata(() => ({
	title: role.value ? role.value.name : (error.value ?? i18n.ts.role),
	icon: 'ti ti-badge',
}));
</script>

<style lang="scss" module>
.root {
	padding: 32px;
	text-align: center;
  align-items: center;
}

.text {
	margin: 0 0 8px 0;
}

.img {
	vertical-align: bottom;
  width: 128px;
	height: 128px;
	margin-bottom: 16px;
	border-radius: 16px;
}
</style>

