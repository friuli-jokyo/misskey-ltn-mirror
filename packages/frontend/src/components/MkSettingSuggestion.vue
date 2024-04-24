<template>
<div v-if="$i" class="_gaps_s">
	<MkInfo v-if="thereIsUnresolvedAbuseReport" warn>{{ i18n.ts.thereIsUnresolvedAbuseReportWarning }} <MkA to="/admin/abuses" class="_link">{{ i18n.ts.check }}</MkA></MkInfo>
	<MkInfo v-else-if="!$i.securityKeys && supported()" warn>{{ i18n.ts.passkeyNotConfiguredWarning }} <MkA to="/settings/security#register-key" class="_link">{{ i18n.ts.configure }}</MkA></MkInfo>
	<MkInfo v-else-if="instance.enableEmail && !$i.emailVerified" warn>{{ i18n.ts.emailNotConfiguredWarning }} <MkA to="/settings/email" class="_link">{{ i18n.ts.configure }}</MkA></MkInfo>
	<MkInfo v-else-if="!$i.twoFactorEnabled" warn>{{ i18n.ts.twoFactorNotConfiguredWarning }} <MkA to="/settings/security" class="_link">{{ i18n.ts.configure }}</MkA></MkInfo>
</div>
</template>

<script lang="ts" setup>
import { supported } from '@github/webauthn-json/browser-ponyfill';
import { ref } from 'vue';
import { $i } from '@/account.js';
import MkInfo from '@/components/MkInfo.vue';
import { i18n } from '@/i18n.js';
import { instance } from '@/instance.js';
import { misskeyApi } from '@/scripts/misskey-api.js';

const thereIsUnresolvedAbuseReport = ref(false);

if ($i?.isAdmin || $i?.isModerator) {
	misskeyApi('admin/abuse-user-reports', {
		state: 'unresolved',
		limit: 1,
	}).then(reports => {
		thereIsUnresolvedAbuseReport.value = !!reports.length;
	});
}
</script>
