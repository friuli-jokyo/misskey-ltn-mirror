<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkContainer :max-height="300" :foldable="true" :onUnfold="unfoldContainer">
	<template #icon><i class="ti ti-photo"></i></template>
	<template #header>{{ i18n.ts.files }}</template>
	<div :class="$style.root">
		<MkLoading v-if="fetching"/>
		<div v-if="!fetching && files.length > 0" :class="$style.stream">
			<MkNoteMediaGrid v-for="entry in files" :key="entry.file.id" :file="entry.file" :to="entry.to"/>
		</div>
		<p v-if="!fetching && files.length == 0" :class="$style.empty">{{ i18n.ts.nothing }}</p>
	</div>
</MkContainer>
</template>

<script lang="ts" setup>
import { onMounted, ref } from 'vue';
import * as Misskey from 'misskey-js';
import { misskeyApi } from '@/scripts/misskey-api.js';
import { notePage } from '@/filters/note.js';
import MkContainer from '@/components/MkContainer.vue';
import { i18n } from '@/i18n.js';
import MkNoteMediaGrid from '@/components/MkNoteMediaGrid.vue';

const props = defineProps<{
	user: Misskey.entities.UserDetailed;
}>();

const emit = defineEmits<{
	(ev: 'unfold'): void;
}>();
const fetching = ref(true);
const files = ref<{
	to: string;
	file: Misskey.entities.DriveFile;
}[]>([]);

function unfoldContainer(): boolean {
	emit('unfold');
	return false;
}

onMounted(() => {
	if (props.user.pinnedGalleryPost) {
		for (const file of props.user.pinnedGalleryPost.files) {
			files.value.push({
				to: `/gallery/${props.user.pinnedGalleryPost.id}`,
				file,
			});
		}
		fetching.value = false;
		return;
	}
	misskeyApi('users/notes', {
		userId: props.user.id,
		withFiles: true,
		limit: 15,
	}).then(notes => {
		for (const note of notes) {
			for (const file of note.files ?? []) {
				files.value.push({
					to: notePage(note),
					file,
				});
			}
		}
		fetching.value = false;
	});
});
</script>

<style lang="scss" module>
.root {
	padding: 8px;
}

.stream {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
	grid-gap: 6px;
}

.img {
	position: relative;
	height: 128px;
	border-radius: 6px;
	overflow: clip;
}

.empty {
	margin: 0;
	padding: 16px;
	text-align: center;
}

.sensitiveImg {
	position: absolute;
	top: 0;
	left: 0;
	width: 100%;
	height: 100%;
	filter: brightness(0.7);
}
.sensitive {
	position: absolute;
	top: 0;
	left: 0;
	width: 100%;
	height: 100%;
	display: grid;
  place-items: center;
	font-size: 0.8em;
	color: #fff;
	cursor: pointer;
}
</style>
