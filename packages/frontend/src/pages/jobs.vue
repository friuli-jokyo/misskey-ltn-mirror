<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :actions="headerActions" :tabs="headerTabs">
	<div class="_spacer" style="--MI_SPACER-w: 800px;">
		<div class="_gaps_m">
			<MkButton v-if="$i && ($i.isAdmin || $i.isModerator)" :class="$style.testButton" primary rounded @click="createTestJob">
				<i class="ti ti-test-pipe"></i> Create Test Job
			</MkButton>
			<MkLoading v-if="isLoading"/>
			<div v-else-if="jobs.length" class="_gaps_s">
				<TransitionGroup tag="div" :name="prefer.s.animation ? 'jobs' : ''" class="_gaps_s">
					<div
						v-for="job in jobs"
						:key="job.id"
						:class="[
							$style.jobCard,
							job.state === 'active' && $style.stateActive,
							job.state === 'completed' && $style.stateCompleted,
							job.state === 'failed' && $style.stateFailed,
							job.state === 'waiting' && $style.stateWaiting,
							job.state === 'waiting-children' && $style.stateWaitingChildren,
							job.state === 'delayed' && $style.stateDelayed,
							job.state === 'prioritized' && $style.statePrioritized,
							job.state === 'unknown' && $style.stateUnknown,
						]"
						class="_panel"
					>
						<div :class="$style.jobHeader">
							<div :class="$style.jobName">{{ job.name }}</div>
							<div :class="$style.jobStatus">
								<span :class="$style.statusBadge">{{ getStateLabel(job.state) }}</span>
							</div>
						</div>
						<div :class="$style.jobMeta">
							<div :class="$style.metaItem">
								<i class="ti ti-clock"></i>
								<span>{{ i18n.ts.created }}: <MkTime :time="job.timestamp" mode="relative"/></span>
							</div>
							<div v-if="job.completedAt" :class="$style.metaItem">
								<i class="ti ti-check"></i>
								<span>{{ i18n.ts.completed }}: <MkTime :time="job.completedAt" mode="relative"/></span>
							</div>
						</div>
						<div v-if="job.progress !== null && job.state === 'active'" :class="$style.progressContainer">
							<div :class="$style.progressBar">
								<div :class="$style.progressFill" :style="{ width: `${Math.min(Math.max(job.progress, 0), 100)}%` }"></div>
							</div>
							<div :class="$style.progressText">{{ job.progress.toFixed(1) }}%</div>
						</div>
						<div v-else-if="job.state === 'active'" :class="$style.processingLabel">
							<i class="ti ti-hourglass"></i> {{ i18n.ts.processing }}
						</div>
					</div>
				</TransitionGroup>
			</div>
			<div v-else :class="$style.empty">
				<div :class="$style.emptyIcon"><i class="ti ti-inbox"></i></div>
				<div :class="$style.emptyText">{{ i18n.ts.noJobs }}</div>
			</div>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import * as Misskey from 'misskey-js';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { TransitionGroup } from 'vue';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { definePage } from '@/page.js';
import { useStream } from '@/stream.js';
import { prefer } from '@/preferences.js';
import MkButton from '@/components/MkButton.vue';
import MkLoading from '@/components/global/MkLoading.vue';
import * as os from '@/os.js';
import { $i } from '@/i.js';

type Job = {
	id: string;
	name: string;
	state: 'completed' | 'failed' | 'delayed' | 'active' | 'waiting' | 'waiting-children' | 'prioritized' | 'unknown';
	progress: number | null;
	timestamp: number;
	completedAt: number | null;
};

const jobs = ref<Job[]>([]);
const isLoading = ref(true);
let connection: Misskey.IChannelConnection<Misskey.Channels['job']> | null = null;

const fetchJobs = async () => {
	try {
		jobs.value = await misskeyApi('i/jobs', {});
	} catch (err) {
		console.error(err);
	} finally {
		isLoading.value = false;
	}
};

const updateJob = (job: Job) => {
	const index = jobs.value.findIndex(j => j.id === job.id);
	if (~index) {
		jobs.value[index] = job;
	} else {
		jobs.value.unshift(job);
	}
};

const getStateLabel = (state: string): string => {
	switch (state) {
		case 'active': return i18n.ts.running;
		case 'completed': return i18n.ts.completed;
		case 'failed': return i18n.ts.failed;
		case 'waiting': return i18n.ts.waiting;
		case 'waiting-children': return i18n.ts.waiting;
		case 'delayed': return i18n.ts.delayed;
		case 'prioritized': return i18n.ts.waiting;
		case 'unknown': return i18n.ts.unknown;
		default: return state;
	}
};

const createTestJob = async () => {
	const { canceled, result } = await os.inputNumber({
		title: 'Create test job',
		text: 'Test job duration (seconds)',
		placeholder: '10',
		default: 10,
	});

	if (canceled || result == null) return;

	try {
		const response = await misskeyApi('admin/test-job', { duration: result });
		if (response?.jobId) {
			os.toast(`Test job created: ${response.jobId}`);
		}
	} catch (err) {
		os.alert({
			type: 'error',
			text: err?.message ?? 'Error',
		});
	}
};

onMounted(() => {
	// Initial fetch
	fetchJobs();

	// Setup WebSocket connection
	connection = useStream().useChannel('job');

	connection.on('jobProgress', updateJob);
	connection.on('jobCompleted', updateJob);
	connection.on('jobFailed', updateJob);
});

onBeforeUnmount(() => {
	if (connection) {
		connection.dispose();
	}
});

const headerActions = computed(() => []);
const headerTabs = computed(() => []);

definePage(computed(() => ({
	title: i18n.ts.jobQueue,
	icon: 'ti ti-clock-play',
})));
</script>

<style lang="scss" module>
.jobCard {
	padding: 1rem;
	border-left: 4px solid var(--MI_THEME-accentLighten);
	border-radius: 4px;

	&:hover {
		background-color: var(--MI_THEME-bg);
	}
}

@mixin stateStyle($color, $opacity: 5%) {
	--job-state-color: #{$color};
	border-left-color: var(--job-state-color);
	background-color: color-mix(in srgb, var(--job-state-color) $opacity, var(--MI_THEME-bg));
}

.stateActive {
	@include stateStyle(var(--MI_THEME-accent));
}

.stateCompleted {
	@include stateStyle(#10b981);
}

.stateFailed {
	@include stateStyle(#ef4444);
}

.stateWaiting {
	@include stateStyle(var(--MI_THEME-fgTransparentWeak), 3%);
}

.stateWaitingChildren {
	@include stateStyle(#8b5cf6);
}

.stateDelayed {
	@include stateStyle(#f59e0b);
}

.statePrioritized {
	@include stateStyle(#ec4899);
}

.stateUnknown {
	--job-state-color: #{var(--MI_THEME-fgTransparentWeak)};
	border-left-color: var(--job-state-color);
	background-color: color-mix(in srgb, var(--job-state-color) 2%, var(--MI_THEME-bg));
	opacity: 0.7;
}

.jobHeader {
	display: flex;
	justify-content: space-between;
	align-items: center;
	margin-bottom: 0.75rem;
	gap: 1rem;
}

.jobName {
	font-weight: 600;
	font-size: 1em;
	flex: 1;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.jobStatus {
	flex-shrink: 0;
}

.statusBadge {
	display: inline-block;
	padding: 0.25rem 0.75rem;
	border-radius: 12px;
	font-size: 0.85em;
	font-weight: 500;
	background-color: color-mix(in srgb, var(--job-state-color, var(--MI_THEME-accent)) 20%, var(--MI_THEME-bg));
	color: var(--job-state-color, var(--MI_THEME-accent));
}

.jobMeta {
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
	margin-bottom: 0.75rem;
	font-size: 0.9em;
	color: var(--MI_THEME-fgTransparentWeak);
}

.metaItem {
	display: flex;
	align-items: center;
	gap: 0.5rem;

	i {
		font-size: 0.85em;
	}
}

.progressContainer {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	margin-bottom: 0.5rem;
}

.progressBar {
	flex: 1;
	height: 8px;
	background-color: var(--MI_THEME-divider);
	border-radius: 4px;
	overflow: hidden;
}

.progressFill {
	height: 100%;
	background: linear-gradient(
		90deg,
		hsl(from var(--job-state-color, var(--MI_THEME-accent)) h s calc(l + 8)),
		var(--job-state-color, var(--MI_THEME-accent))
	);
	border-radius: 4px;
	transition: width 0.3s ease;
}

.progressText {
	font-size: 0.9em;
	font-variant-numeric: tabular-nums;
	color: var(--MI_THEME-fgTransparentWeak);
	min-width: 3.5em;
	text-align: right;
}

.processingLabel {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	font-size: 0.9em;
	color: var(--MI_THEME-accent);
	font-style: italic;

	i {
		font-size: 0.85em;
		animation: spin 2s linear infinite;
	}
}

.empty {
	display: flex;
	flex-direction: column;
	justify-content: center;
	align-items: center;
	min-height: 300px;
	color: var(--MI_THEME-fgTransparentWeak);
}

.emptyIcon {
	font-size: 3em;
	margin-bottom: 1rem;
	opacity: 0.5;
}

.emptyText {
	font-size: 1.1em;
}

.testButton {
	width: 100%;
}

@keyframes spin {
	from {
		transform: rotate(0deg);
	}
	to {
		transform: rotate(360deg);
	}
}

.jobs-enter-active,
.jobs-leave-active {
	transition: all 0.3s ease;
}

.jobs-enter-from {
	opacity: 0;
	transform: translateY(-10px);
}

.jobs-leave-to {
	opacity: 0;
	transform: translateY(10px);
}

.jobs-move {
	transition: transform 0.3s ease;
}
</style>
