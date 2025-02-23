<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
	<MkSpacer :contentMax="1100">
		<div :class="$style.root">
			<MkPagination v-slot="{items}" :pagination="pagination">
				<div :class="$style.stream">
					<template v-for="note in items" :key="note.id">
						<MkNoteMediaGrid v-for="file in note.files ?? []" :key="file.id" :file="file" :to="notePage(note)" square/>
					</template>
				</div>
			</MkPagination>
		</div>
	</MkSpacer>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import * as Misskey from 'misskey-js';

import MkNoteMediaGrid from '@/components/MkNoteMediaGrid.vue';
import MkPagination from '@/components/MkPagination.vue';
import { notePage } from '@/filters/note.js';

const props = defineProps<{
	user: Misskey.entities.UserDetailed;
}>();

const pagination = {
	endpoint: 'users/notes' as const,
	limit: 15,
	params: computed(() => ({
		userId: props.user.id,
		withFiles: true,
	})),
};
</script>

<style lang="scss" module>
.root {
	padding: 8px;
}

.stream {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
	gap: var(--MI-marginHalf);
}

@media screen and (min-width: 600px) {
	.stream {
		grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
	}

}
</style>
