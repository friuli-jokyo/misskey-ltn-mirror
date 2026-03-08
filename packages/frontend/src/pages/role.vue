<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkStickyContainer>
	<template #header><MkPageHeader v-model:tab="tab" :tabs="headerTabs" :actions="headerActions"/></template>
	<div v-if="error != null" class="_spacer" style="--MI_SPACER-max: 1200px;">
		<div :class="$style.root">
			<img :class="$style.img" :src="instance.serverErrorImageUrl" class="_ghost"/>
			<p>{{ error }}</p>
		</div>
	</div>
	<div v-else-if="tab === 'users'" class="_spacer" style="--MI_SPACER-max: 1200px;">
		<div v-if="role" class="_gaps_s">
			<div>{{ role.description }}</div>
			<MkUserList v-if="visible" :paginator="usersPaginator" :extractor="(item) => item.user"/>
			<MkResult v-else-if="!visible" type="empty" :text="i18n.ts.nothing"/>
		</div>
	</div>
	<div v-else-if="tab === 'timeline'" class="_spacer" style="--MI_SPACER-max: 700px;">
		<MkStreamingNotesTimeline v-if="visible" ref="timeline" src="role" :role="props.roleId"/>
		<MkResult v-else-if="!visible" type="empty" :text="i18n.ts.nothing"/>
	</div>
</MkStickyContainer>
</template>

<script lang="ts" setup>
import { computed, watch, ref, markRaw } from 'vue';
import * as Misskey from 'misskey-js';
import { $i } from '@/i.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import MkUserList from '@/components/MkUserList.vue';
import { definePage } from '@/page.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import MkStreamingNotesTimeline from '@/components/MkStreamingNotesTimeline.vue';
import { Paginator } from '@/utility/paginator.js';
import { instance } from '@/instance.js';
import MkPageHeader from '@/components/global/MkPageHeader.vue';
import MkStickyContainer from '@/components/global/MkStickyContainer.vue';
import MkResult from '@/components/global/MkResult.vue';

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
	endpoint: 'roles/users',
	limit: 30,
	params: {
		roleId: props.roleId,
	},
}));

const usersPaginator = markRaw(new Paginator('roles/users', {
	limit: 30,
	computedParams: computed(() => ({
		roleId: props.roleId,
	})),
}));

const headerActions = computed(() =>
	role.value?.target === 'manual'
		? $i?.policies.selfAssignability?.some(([t, u]) => u && role.value!.tags.includes(t))
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
			: $i?.policies.selfAssignability?.some(([t, u]) => role.value!.tags.includes(t))
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
		title: i18n.ts.period + ': ' + role.value!.name,
		items: [{
			value: 'indefinitely', label: i18n.ts.indefinitely,
		}, {
			value: 'oneHour', label: i18n.ts.oneHour,
		}, {
			value: 'oneDay', label: i18n.ts.oneDay,
		}, {
			value: 'oneWeek', label: i18n.ts.oneWeek,
		}, {
			value: 'oneMonth', label: i18n.ts.oneMonth,
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

	os.apiWithDialog('admin/roles/assign', { roleId: role.value!.id, userId: $i!.id, expiresAt });
}

async function assignIndefinetly() {
	const { canceled } = await os.confirm({
		type: 'warning',
		title: i18n.ts.areYouSure,
	});
	if (canceled) return;

	os.apiWithDialog('admin/roles/assign', { roleId: role.value!.id, userId: $i!.id });
}

async function unassign() {
	const { canceled } = await os.confirm({
		type: 'warning',
		title: i18n.ts.areYouSure,
	});
	if (canceled) return;

	os.apiWithDialog('admin/roles/unassign', { roleId: role.value!.id, userId: $i!.id });
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

definePage(() => ({
	title: role.value ? role.value.name : (error.value ?? i18n.ts.role),
	icon: 'ti ti-badge',
}));
</script>
