<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps">
	<div class="_gaps">
		<MkInput
			v-model="searchQuery"
			large
			autofocus
			type="search"
			@enter.prevent="search"
		>
			<template #prefix><i class="ti ti-search"></i></template>
		</MkInput>
		<MkFoldableSection expanded>
			<template #header>{{ i18n.ts.options }}</template>

			<div class="_gaps_m">
				<MkRadios
					v-model="searchScope"
					:options="searchScopeDef"
				>
				</MkRadios>

				<MkRadios
					v-model="targetScope"
					:options="targetScopeDef"
				>
				</MkRadios>

				<MkRadios
					v-model="rangeScope"
					:options="rangeScopeDef"
				>
				</MkRadios>

				<div v-if="instance.federation !== 'none' && searchScope === 'server'" :class="$style.subOptionRoot">
					<MkInput
						v-model="hostInput"
						:placeholder="i18n.ts._search.serverHostPlaceholder"
						@enter.prevent="search"
					>
						<template #label>{{ i18n.ts._search.pleaseEnterServerHost }}</template>
						<template #prefix><i class="ti ti-server"></i></template>
					</MkInput>
				</div>

				<div v-if="searchScope === 'user'" :class="$style.subOptionRoot">
					<div :class="$style.userSelectLabel">{{ i18n.ts._search.pleaseSelectUser }}</div>
					<div class="_gaps">
						<div v-if="user == null" :class="$style.userSelectButtons">
							<div v-if="$i != null">
								<MkButton
									transparent
									:class="$style.userSelectButton"
									@click="selectSelf"
								>
									<div :class="$style.userSelectButtonInner">
										<span><i class="ti ti-plus"></i><i class="ti ti-user"></i></span>
										<span>{{ i18n.ts.selectSelf }}</span>
									</div>
								</MkButton>
							</div>
							<div :style="$i == null ? 'grid-column: span 2;' : undefined">
								<MkButton
									transparent
									:class="$style.userSelectButton"
									@click="selectUser"
								>
									<div :class="$style.userSelectButtonInner">
										<span><i class="ti ti-plus"></i></span>
										<span>{{ i18n.ts.selectUser }}</span>
									</div>
								</MkButton>
							</div>
						</div>
						<div v-else :class="$style.userSelectedButtons">
							<div style="overflow: hidden;">
								<MkUserCardMini
									:user="user"
									:withChart="false"
								/>
							</div>
							<div>
								<button
									class="_button"
									:class="$style.userSelectedRemoveButton"
									@click="removeUser"
								>
									<i class="ti ti-x"></i>
								</button>
							</div>
						</div>
					</div>
				</div>

				<MkFolder v-if="rangeScope === 'specified'" :defaultOpen="true">
					<template #label>{{ i18n.ts._poll.duration }}</template>
					<template v-if="sinceDate || untilDate" #suffix>
						{{ sinceDate || '...' }} - {{ untilDate || '...' }}
					</template>
					<div class="_gaps" :class="$style.range">
						<MkInput
							v-model="sinceDate"
							:class="$style.dtl"
							type="datetime-local"
						/>
						-
						<MkInput
							v-model="untilDate"
							:class="$style.dtl"
							type="datetime-local"
						/>
					</div>
				</MkFolder>

				<MkFolder>
					<template #label>{{ i18n.ts.repliedCount }}</template>
					<template v-if="Number.isSafeInteger(minRepliesCount) || Number.isSafeInteger(maxRepliesCount)" #suffix>
						{{ Number.isSafeInteger(minRepliesCount) ? minRepliesCount : 0 }}
						-
						{{ Number.isSafeInteger(maxRepliesCount) ? maxRepliesCount : '∞' }}
					</template>
					<div class="_gaps">
						<div class="_gaps" :class="$style.range">
							<MkInput
								v-model="minRepliesCount"
								:class="$style.dtl"
								type="number"
							/>
							-
							<MkInput
								v-model="maxRepliesCount"
								:class="$style.dtl"
								type="number"
							/>
						</div>
					</div>
				</MkFolder>

				<MkFolder>
					<template #label>{{ i18n.ts.renotedCount }}</template>
					<template v-if="Number.isSafeInteger(minRenoteCount) || Number.isSafeInteger(maxRenoteCount)" #suffix>
						{{ Number.isSafeInteger(minRenoteCount) ? minRenoteCount : 0 }}
						-
						{{ Number.isSafeInteger(maxRenoteCount) ? maxRenoteCount : '∞' }}
					</template>
					<div class="_gaps">
						<div class="_gaps" :class="$style.range">
							<MkInput
								v-model="minRenoteCount"
								:class="$style.dtl"
								type="number"
							/>
							-
							<MkInput
								v-model="maxRenoteCount"
								:class="$style.dtl"
								type="number"
							/>
						</div>
					</div>
				</MkFolder>

				<MkFolder>
					<template #label>{{ i18n.ts.receivedReactionsCount }}</template>
					<template v-if="Number.isSafeInteger(minReactionsCount) || Number.isSafeInteger(maxReactionsCount)" #suffix>
						{{ Number.isSafeInteger(minReactionsCount) ? minReactionsCount : 0 }}
						-
						{{ Number.isSafeInteger(maxReactionsCount) ? maxReactionsCount : '∞' }}
					</template>
					<div class="_gaps">
						<div class="_gaps" :class="$style.range">
							<MkInput
								v-model="minReactionsCount"
								:class="$style.dtl"
								type="number"
							/>
							-
							<MkInput
								v-model="maxReactionsCount"
								:class="$style.dtl"
								type="number"
							/>
						</div>
					</div>
				</MkFolder>
			</div>
		</MkFoldableSection>
		<div>
			<MkButton
				large
				primary
				gradate
				rounded
				:disabled="searchParams == null"
				style="margin: 0 auto;"
				@click="search"
			>
				{{ i18n.ts.search }}
			</MkButton>
		</div>
	</div>

	<MkFoldableSection v-if="paginator">
		<template #header>{{ i18n.ts.searchResult }}</template>
		<MkNotesTimeline :key="`searchNotes:${key}`" :paginator="paginator"/>
	</MkFoldableSection>
</div>
</template>

<script lang="ts" setup>
import { computed, markRaw, ref, shallowRef, toRef } from 'vue';
import { host as localHost } from '@@/js/config.js';
import type * as Misskey from 'misskey-js';
import type { MkRadiosOption } from '@/components/MkRadios.vue';
import { $i } from '@/i.js';
import { i18n } from '@/i18n.js';
import { instance } from '@/instance.js';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { apLookup } from '@/utility/lookup.js';
import { useRouter } from '@/router.js';
import MkButton from '@/components/MkButton.vue';
import MkFoldableSection from '@/components/MkFoldableSection.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkInput from '@/components/MkInput.vue';
import MkNotesTimeline from '@/components/MkNotesTimeline.vue';
import MkRadios from '@/components/MkRadios.vue';
import MkUserCardMini from '@/components/MkUserCardMini.vue';
import { Paginator } from '@/utility/paginator.js';

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
const paginator = shallowRef<Paginator<'notes/search'> | null>(null);

const searchQuery = ref(toRef(props, 'query').value);
const hostInput = ref(toRef(props, 'host').value);
const sinceDate = ref('');
const untilDate = ref('');
const minRepliesCount = ref<number | null>(null);
const maxRepliesCount = ref<number | null>(null);
const minRenoteCount = ref<number | null>(null);
const maxRenoteCount = ref<number | null>(null);
const minReactionsCount = ref<number | null>(null);
const maxReactionsCount = ref<number | null>(null);

const user = shallowRef<Misskey.entities.UserDetailed | null>(null);

// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
const noteSearchableScope = instance.noteSearchableScope ?? 'local';

//#region set user
let fetchedUser: Misskey.entities.UserDetailed | null = null;

if (props.userId) {
	fetchedUser = await misskeyApi('users/show', {
		userId: props.userId,
	}).catch(() => null);
}

if (props.username && fetchedUser == null) {
	fetchedUser = await misskeyApi('users/show', {
		username: props.username,
		...(props.host ? { host: props.host } : {}),
	}).catch(() => null);
}

if (fetchedUser != null) {
	if (!(noteSearchableScope === 'local' && fetchedUser.host != null)) {
		user.value = fetchedUser;
	}
}
//#endregion

const searchScope = ref<'all' | 'local' | 'server' | 'user'>((() => {
	if (user.value != null) return 'user';
	if (noteSearchableScope === 'local') return 'local';
	if (hostInput.value) return 'server';
	return 'all';
})());

const targetScope = ref<'all' | 'follows' | 'mentioned' | 'specified'>('all');

const rangeScope = ref<'recent' | 'today' | 'thisMonth' | 'thisYear' | 'specified'>('recent');

const searchScopeDef = computed<MkRadiosOption[]>(() => {
	const options: MkRadiosOption[] = [];

	if (instance.federation !== 'none' && noteSearchableScope === 'global') {
		options.push({ value: 'all', label: i18n.ts._search.searchScopeAll });
	}

	options.push({ value: 'local', label: instance.federation === 'none' ? i18n.ts._search.searchScopeAll : i18n.ts._search.searchScopeLocal });

	if (instance.federation !== 'none' && noteSearchableScope === 'global') {
		options.push({ value: 'server', label: i18n.ts._search.searchScopeServer });
	}

	options.push({ value: 'user', label: i18n.ts._search.searchScopeUser });

	return options;
});

const targetScopeDef = computed<MkRadiosOption[]>(() => [
	{ value: 'all', label: i18n.ts.all },
	{ value: 'follows', label: i18n.ts.following },
	{ value: 'mentioned', label: i18n.ts.mentions },
	{ value: 'specified', label: i18n.ts.directNotes },
]);

const rangeScopeDef = computed<MkRadiosOption[]>(() => [
	{ value: 'recent', label: i18n.ts.recentPosts },
	{ value: 'today', label: i18n.ts.today },
	{ value: 'thisMonth', label: i18n.ts.thisMonth },
	{ value: 'thisYear', label: i18n.ts.thisYear },
	{ value: 'specified', label: i18n.ts.specified },
]);

type SearchRequestParams = {
	readonly query: string;
	readonly host?: string;
	readonly userId?: string;
	readonly sinceId?: string;
	readonly untilId?: string;
	readonly sinceDate?: number;
	readonly untilDate?: number;
	readonly onlyFollows?: boolean;
	readonly onlyMentioned?: boolean;
	readonly onlySpecified?: boolean;
	readonly minRenoteCount?: number;
	readonly maxRenoteCount?: number;
	readonly minRepliesCount?: number;
	readonly maxRepliesCount?: number;
	readonly minReactionsCount?: number;
	readonly maxReactionsCount?: number;
};

const parseIntFilter = (value: number | null): number | undefined => {
	if (value == null) return undefined;
	if (!Number.isSafeInteger(value) || value < 0) return undefined;
	return value;
};

const parseDateFilter = (value: string): number | undefined => {
	if (!value) return undefined;
	const parsed = new Date(value).valueOf();
	return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const fixHostIfLocal = (target: string | null | undefined) => {
	if (!target || target === localHost) return '.';
	return target;
};

const searchParams = computed<SearchRequestParams | null>(() => {
	const trimmedQuery = searchQuery.value.trim();
	if (!trimmedQuery) return null;

	let sinceId: string | undefined;
	let untilId: string | undefined;
	let sinceDateValue: number | undefined;
	let untilDateValue: number | undefined;

	const now = new Date();
	switch (rangeScope.value) {
		case 'recent': {
			const since = now.valueOf() - 9466848e5;
			const until = since + 0x81bf1000;
			sinceId = since.toString(36).padStart(8, '0').slice(0, 2) + '00000000';
			untilId = until.toString(36).padStart(8, '0').slice(0, 2) + '00000000';
			break;
		}

		case 'today':
			sinceDateValue = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();
			untilDateValue = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).valueOf();
			break;

		case 'thisMonth':
			sinceDateValue = new Date(now.getFullYear(), now.getMonth(), 1).valueOf();
			untilDateValue = new Date(now.getFullYear(), now.getMonth() + 1, 1).valueOf();
			break;

		case 'thisYear':
			sinceDateValue = new Date(now.getFullYear(), 0, 1).valueOf();
			untilDateValue = new Date(now.getFullYear() + 1, 0, 1).valueOf();
			break;

		case 'specified':
			sinceDateValue = parseDateFilter(sinceDate.value);
			untilDateValue = parseDateFilter(untilDate.value) ?? (sinceDate.value ? new Date().valueOf() : undefined);
			break;
	}

	const derived = {
		query: trimmedQuery,
		sinceId,
		untilId,
		sinceDate: sinceDateValue,
		untilDate: untilDateValue,
		onlyFollows: targetScope.value === 'follows',
		onlyMentioned: targetScope.value === 'mentioned',
		onlySpecified: targetScope.value === 'specified',
		minRepliesCount: parseIntFilter(minRepliesCount.value),
		maxRepliesCount: parseIntFilter(maxRepliesCount.value),
		minRenoteCount: parseIntFilter(minRenoteCount.value),
		maxRenoteCount: parseIntFilter(maxRenoteCount.value),
		minReactionsCount: parseIntFilter(minReactionsCount.value),
		maxReactionsCount: parseIntFilter(maxReactionsCount.value),
	} satisfies SearchRequestParams;

	if (searchScope.value === 'user') {
		if (user.value == null) return null;
		return {
			...derived,
			host: fixHostIfLocal(user.value.host),
			userId: user.value.id,
		};
	}

	if (instance.federation !== 'none' && searchScope.value === 'server') {
		let trimmedHost = hostInput.value?.trim();
		if (!trimmedHost) return null;
		if (trimmedHost.startsWith('https://') || trimmedHost.startsWith('http://')) {
			try {
				trimmedHost = new URL(trimmedHost).host;
			} catch { /* empty */ }
		}
		return {
			...derived,
			host: fixHostIfLocal(trimmedHost),
		};
	}

	if (instance.federation === 'none' || searchScope.value === 'local') {
		return {
			...derived,
			host: '.',
		};
	}

	return {
		...derived,
	};
});

function selectUser() {
	os.selectUser({
		includeSelf: true,
		localOnly: instance.noteSearchableScope === 'local',
	}).then(_user => {
		user.value = _user;
	});
}

function selectSelf() {
	user.value = $i;
}

function removeUser() {
	user.value = null;
}

async function search() {
	if (searchParams.value == null) return;

	//#region AP lookup
	if (searchParams.value.query.startsWith('https://') && !searchParams.value.query.includes(' ')) {
		const confirm = await os.confirm({
			type: 'info',
			text: i18n.ts.lookupConfirm,
		});
		if (!confirm.canceled) {
			const res = await apLookup(searchParams.value.query);

			if (res.type === 'User') {
				router.push('/@:acct/:page?', {
					params: {
						acct: `${res.object.username}@${res.object.host}`,
					},
				});
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
			} else if (res.type === 'Note') {
				router.push('/notes/:noteId/:initialTab?', {
					params: {
						noteId: res.object.id,
					},
				});
			}

			return;
		}
	}
	//#endregion

	if (searchParams.value.query.length > 1 && !searchParams.value.query.includes(' ')) {
		if (searchParams.value.query.startsWith('@')) {
			const confirm = await os.confirm({
				type: 'info',
				text: i18n.ts.lookupConfirm,
			});
			if (!confirm.canceled) {
				router.pushByPath(`/${searchParams.value.query}`);
				return;
			}
		}

		if (searchParams.value.query.startsWith('#')) {
			const confirm = await os.confirm({
				type: 'info',
				text: i18n.ts.openTagPageConfirm,
			});
			if (!confirm.canceled) {
				router.push('/tags/:tag', {
					params: {
						tag: searchParams.value.query.substring(1),
					},
				});
				return;
			}
		}
	}

	paginator.value = markRaw(new Paginator('notes/search', {
		limit: 10,
		params: {
			...searchParams.value,
		} as Misskey.Endpoints['notes/search']['req'],
	}));

	key.value++;
}
</script>
<style lang="scss" module>
.subOptionRoot {
	background: var(--MI_THEME-panel);
	border-radius: var(--MI-radius);
	padding: var(--MI-margin);
}

.range {
	display: flex;
	flex-direction: row;
	flex-wrap: nowrap;
	align-items: center;
	gap: 8px;
}

.dtl {
	flex: 1 1 0;
	min-width: 0;
}

.userSelectLabel {
	font-size: 0.85em;
	padding: 0 0 8px;
	user-select: none;
}

.userSelectButtons {
	display: grid;
	grid-template-columns: auto 1fr;
	gap: 16px;
}

.userSelectButton {
	width: 100%;
	height: 100%;
	padding: 12px;
	border: 2px dashed color(from var(--MI_THEME-fg) srgb r g b / 0.5);
}

.userSelectButtonInner {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: space-between;
	min-height: 38px;
}

.userSelectedButtons {
	display: grid;
	grid-template-columns: 1fr auto;
	align-items: center;
}

.userSelectedRemoveButton {
	width: 32px;
	height: 32px;
	color: #ff2a2a;
}
</style>
