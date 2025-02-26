<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps">
	<div class="_gaps">
		<MkInput v-model="searchQuery" :large="true" :autofocus="true" type="search" @enter.prevent="search">
			<template #prefix><i class="ti ti-search"></i></template>
		</MkInput>
		<MkFoldableSection :expanded="true">
			<template #header>{{ i18n.ts.options }}</template>

			<div class="_gaps_m">
				<template v-if="instance.federation !== 'none'">
					<MkRadios v-model="hostSelect">
						<template #label>{{ i18n.ts.host }}</template>
						<option value="all" default>{{ i18n.ts.all }}</option>
						<option value="local">{{ i18n.ts.local }}</option>
						<option v-if="noteSearchableScope === 'global'" value="specified">{{ i18n.ts.specifyHost }}</option>
					</MkRadios>
					<MkInput v-if="noteSearchableScope === 'global'" v-model="hostInput" :disabled="hostSelect !== 'specified'" :large="true" type="search">
						<template #prefix><i class="ti ti-server"></i></template>
					</MkInput>
				</template>

				<MkRadios v-model="targetSelect">
					<template #label>{{ i18n.ts.target }}</template>
					<option value="all" default>{{ i18n.ts.all }}</option>
					<option value="follows">{{ i18n.ts.following }}</option>
					<option value="mentioned">{{ i18n.ts.mentions }}</option>
					<option value="specified">{{ i18n.ts.directNotes }}</option>
				</MkRadios>

				<MkFolder :defaultOpen="true">
					<template #label>{{ i18n.ts.specifyUser }}</template>
					<template v-if="user" #suffix>@{{ user.username }}{{ user.host ? `@${user.host}` : "" }}</template>

					<div class="_gaps">
						<div :class="$style.userItem">
							<MkUserCardMini v-if="user" :class="$style.userCard" :user="user" :withChart="false"/>
							<MkButton v-if="user == null && $i != null" transparent :class="$style.addMeButton" @click="selectSelf"><div :class="$style.addUserButtonInner"><span><i class="ti ti-plus"></i><i class="ti ti-user"></i></span><span>{{ i18n.ts.selectSelf }}</span></div></MkButton>
							<MkButton v-if="user == null" transparent :class="$style.addUserButton" @click="selectUser"><div :class="$style.addUserButtonInner"><i class="ti ti-plus"></i><span>{{ i18n.ts.selectUser }}</span></div></MkButton>
							<button class="_button" :class="$style.remove" :disabled="user == null" @click="removeUser"><i class="ti ti-x"></i></button>
						</div>
					</div>
				</MkFolder>

				<MkFolder :defaultOpen="true">
					<template #label>{{ i18n.ts._poll.duration }}</template>
					<template v-if="sinceDate || untilDate" #suffix>
						<MkTime v-if="sinceDate" :time="sinceDate" mode="absolute"/>
						-
						<MkTime v-if="untilDate" :time="untilDate" mode="absolute"/>
					</template>

					<div class="_gaps" :class="$style.range">
						<MkInput v-model="sinceDate" :class="$style.dtl" type="datetime-local"/>
						-
						<MkInput v-model="untilDate" :class="$style.dtl" type="datetime-local"/>
					</div>
				</MkFolder>

				<MkFolder>
					<template #label>{{ i18n.ts.repliedCount }}</template>
					<template v-if="repliesCount" #suffix>
						{{ Number.isSafeInteger(minRepliesCount) ? minRepliesCount : 0 }}
						-
						{{ Number.isSafeInteger(maxRepliesCount) ? maxRepliesCount : '∞' }}
					</template>

					<div class="_gaps">
						<MkSwitch v-model="repliesCount">
							<template #label>{{ i18n.ts.configure }}</template>
						</MkSwitch>
						<div class="_gaps" :class="$style.range">
							<MkInput v-model="minRepliesCount" :class="$style.dtl" type="number"/>
							-
							<MkInput v-model="maxRepliesCount" :class="$style.dtl" type="number"/>
						</div>
					</div>
				</MkFolder>

				<MkFolder>
					<template #label>{{ i18n.ts.renotedCount }}</template>
					<template v-if="renoteCount" #suffix>
						{{ Number.isSafeInteger(minRenoteCount) ? minRenoteCount : 0 }}
						-
						{{ Number.isSafeInteger(maxRenoteCount) ? maxRenoteCount : '∞' }}
					</template>

					<div class="_gaps">
						<MkSwitch v-model="renoteCount">
							<template #label>{{ i18n.ts.configure }}</template>
						</MkSwitch>
						<div class="_gaps" :class="$style.range">
							<MkInput v-model="minRenoteCount" :class="$style.dtl" type="number"/>
							-
							<MkInput v-model="maxRenoteCount" :class="$style.dtl" type="number"/>
						</div>
					</div>
				</MkFolder>

				<MkFolder>
					<template #label>{{ i18n.ts.receivedReactionsCount }}</template>
					<template v-if="reactionsCount" #suffix>
						{{ Number.isSafeInteger(minReactionsCount) ? minReactionsCount : 0 }}
						-
						{{ Number.isSafeInteger(maxReactionsCount) ? maxReactionsCount : '∞' }}
					</template>

					<div class="_gaps">
						<MkSwitch v-model="reactionsCount">
							<template #label>{{ i18n.ts.configure }}</template>
						</MkSwitch>
						<div class="_gaps" :class="$style.range">
							<MkInput v-model="minReactionsCount" :class="$style.dtl" type="number"/>
							-
							<MkInput v-model="maxReactionsCount" :class="$style.dtl" type="number"/>
						</div>
					</div>
				</MkFolder>
			</div>
		</MkFoldableSection>
		<div>
			<MkButton large primary gradate rounded style="margin: 0 auto;" @click="search">{{ i18n.ts.search }}</MkButton>
		</div>
	</div>

	<MkFoldableSection v-if="notePagination">
		<template #header>{{ i18n.ts.searchResult }}</template>
		<MkNotes :key="key" :pagination="notePagination"/>
	</MkFoldableSection>
</div>
</template>

<script lang="ts" setup>
import { computed, ref, toRef, watch } from 'vue';
import type { UserDetailed } from 'misskey-js/entities.js';
import type { Paging } from '@/components/MkPagination.vue';
import MkNotes from '@/components/MkNotes.vue';
import MkInput from '@/components/MkInput.vue';
import MkButton from '@/components/MkButton.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { misskeyApi } from '@/scripts/misskey-api.js';
import MkFoldableSection from '@/components/MkFoldableSection.vue';
import MkFolder from '@/components/MkFolder.vue';
import { useRouter } from '@/router/supplier.js';
import MkUserCardMini from '@/components/MkUserCardMini.vue';
import MkRadios from '@/components/MkRadios.vue';
import { $i } from '@/account.js';
import { instance } from '@/instance.js';

const props = withDefaults(defineProps<{
	query?: string;
	userId?: string;
	username?: string;
	host?: string | null;
}>(), {
	query: '',
	userId: undefined,
	username: undefined,
	host: '',
});

const router = useRouter();
const key = ref(0);
const searchQuery = ref(toRef(props, 'query').value);
const notePagination = ref<Paging>();
const user = ref<UserDetailed | null>(null);
const hostInput = ref(toRef(props, 'host').value);
const sinceDate = ref('');
const untilDate = ref('');
const repliesCount = ref(false);
const minRepliesCount = ref<number | null>(null);
const maxRepliesCount = ref<number | null>(null);
const renoteCount = ref(false);
const minRenoteCount = ref<number | null>(null);
const maxRenoteCount = ref<number | null>(null);
const reactionsCount = ref(false);
const minReactionsCount = ref<number | null>(null);
const maxReactionsCount = ref<number | null>(null);

const noteSearchableScope = instance.noteSearchableScope ?? 'local';

const hostSelect = ref<'all' | 'local' | 'specified'>('all');
const targetSelect = ref<'all' | 'follows' | 'mentioned' | 'specified'>('all');

const setHostSelectWithInput = (after: string | undefined | null, before: string | undefined | null) => {
	if (before === after) return;
	if (after === '') hostSelect.value = 'all';
	else hostSelect.value = 'specified';
};

setHostSelectWithInput(hostInput.value, undefined);

watch(hostInput, setHostSelectWithInput);

const searchHost = computed(() => {
	if (hostSelect.value === 'local' || instance.federation === 'none') return '.';
	if (hostSelect.value === 'specified') return hostInput.value;
	return null;
});

if (props.userId != null) {
	misskeyApi('users/show', { userId: props.userId }).then(_user => {
		user.value = _user;
	});
} else if (props.username != null) {
	misskeyApi('users/show', {
		username: props.username,
		...(props.host != null && props.host !== '') ? { host: props.host } : {},
	}).then(_user => {
		user.value = _user;
	});
}

function selectUser() {
	os.selectUser({ includeSelf: true, localOnly: instance.noteSearchableScope === 'local' }).then(_user => {
		user.value = _user;
		hostInput.value = _user.host ?? '';
	});
}

function selectSelf() {
	user.value = $i as UserDetailed | null;
	hostInput.value = null;
}

function removeUser() {
	user.value = null;
	hostInput.value = '';
}

async function search() {
	const query = searchQuery.value.toString().trim();

	if (query == null || query === '') return;

	//#region AP lookup
	if (query.startsWith('https://') && !query.includes(' ')) {
		const confirm = await os.confirm({
			type: 'info',
			text: i18n.ts.lookupConfirm,
		});
		if (!confirm.canceled) {
			const promise = misskeyApi('ap/show', {
				uri: query,
			});

			os.promiseDialog(promise, null, null, i18n.ts.fetchingAsApObject);

			const res = await promise;

			if (res.type === 'User') {
				router.push(`/@${res.object.username}@${res.object.host}`);
			} else if (res.type === 'Note') {
				router.push(`/notes/${res.object.id}`);
			}

			return;
		}
	}
	//#endregion

	if (query.length > 1 && !query.includes(' ')) {
		if (query.startsWith('@')) {
			const confirm = await os.confirm({
				type: 'info',
				text: i18n.ts.lookupConfirm,
			});
			if (!confirm.canceled) {
				router.push(`/${query}`);
				return;
			}
		}

		if (query.startsWith('#')) {
			const confirm = await os.confirm({
				type: 'info',
				text: i18n.ts.openTagPageConfirm,
			});
			if (!confirm.canceled) {
				router.push(`/tags/${encodeURIComponent(query.substring(1))}`);
				return;
			}
		}
	}

	notePagination.value = {
		endpoint: 'notes/search',
		limit: 10,
		params: {
			query: searchQuery.value,
			userId: user.value ? user.value.id : null,
			...(searchHost.value ? { host: searchHost.value } : {}),
			sinceDate: sinceDate.value ? new Date(sinceDate.value).valueOf() : undefined,
			untilDate: untilDate.value ? new Date(untilDate.value).valueOf() : undefined,
			onlyFollows: targetSelect.value === 'follows',
			onlyMentioned: targetSelect.value === 'mentioned',
			onlySpecified: targetSelect.value === 'specified',
			minRenoteCount: renoteCount.value && Number.isSafeInteger(minRenoteCount.value) ? minRenoteCount.value : undefined,
			maxRenoteCount: renoteCount.value && Number.isSafeInteger(maxRenoteCount.value) ? maxRenoteCount.value : undefined,
			minRepliesCount: repliesCount.value && Number.isSafeInteger(minRepliesCount.value) ? minRepliesCount.value : undefined,
			maxRepliesCount: repliesCount.value && Number.isSafeInteger(maxRepliesCount.value) ? maxRepliesCount.value : undefined,
			minReactionsCount: reactionsCount.value && Number.isSafeInteger(minReactionsCount.value) ? minReactionsCount.value : undefined,
			maxReactionsCount: reactionsCount.value && Number.isSafeInteger(maxReactionsCount.value) ? maxReactionsCount.value : undefined,
		},
	};

	key.value++;
}
</script>

<style lang="scss" module>
.userItem {
	display: flex;
	justify-content: center;
}
.addMeButton {
  border: 2px dashed var(--MI_THEME-fgTransparent);
	padding: 12px;
	margin-right: 16px;
}
.addUserButton {
  border: 2px dashed var(--MI_THEME-fgTransparent);
	padding: 12px;
	flex-grow: 1;
}
.addUserButtonInner {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: space-between;
	min-height: 38px;
}
.userCard {
	flex-grow: 1;
}
.remove {
	width: 32px;
	height: 32px;
	align-self: center;

	& > i:before {
		color: #ff2a2a;
	}

	&:disabled {
		opacity: 0;
	}
}
.range {
	flex-flow: row;
	align-items: center;
	justify-content: space-between;
}
.dtl {
	flex: 1;
}
</style>
