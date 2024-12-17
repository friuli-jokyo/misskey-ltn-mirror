<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.signinRoot">
	<Transition
		mode="out-in"
		:enterActiveClass="$style.transition_enterActive"
		:leaveActiveClass="$style.transition_leaveActive"
		:enterFromClass="$style.transition_enterFrom"
		:leaveToClass="$style.transition_leaveTo"

		:inert="waiting"
	>
		<!-- 1. 外部サーバーへの転送・username入力・パスキー -->
		<XInput
			v-if="page === 'input'"
			key="input"
			:message="message"
			:openOnRemote="openOnRemote"
			:useConditionalMediation="useConditionalMediation"

			@passwordProvided="onPasswordProvided"
			@usernameSubmitted="onUsernameSubmitted"
			@passkeyClick="onPasskeyLogin"
			@done="onConditionalMediationDone"
		/>

		<!-- 2. パスワード入力 -->
		<XPassword
			v-else-if="page === 'password'"
			key="password"
			ref="passwordPageEl"

			:user="userInfo!"
			:needCaptcha="needCaptcha"

			@passwordSubmitted="onPasswordSubmitted"
		/>

		<!-- 3. ワンタイムパスワード -->
		<XTotp
			v-else-if="page === 'totp'"
			key="totp"

			@totpSubmitted="onTotpSubmitted"
		/>

		<!-- 4. パスキー -->
		<XPasskey
			v-else-if="page === 'passkey'"
			key="passkey"

			:credentialRequest="credentialRequest!"
			:isPerformingPasswordlessLogin="doingPasskeyFromInputPage"

			@done="onPasskeyDone"
			@useTotp="onUseTotp"
		/>
	</Transition>
	<div v-if="waiting" :class="$style.waitingRoot">
		<MkLoading/>
	</div>
</div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, useTemplateRef } from 'vue';
import * as Misskey from 'misskey-js';
import { parseRequestOptionsFromJSON, create as webAuthnCreate, get as webAuthnRequest, supported as webAuthnSupported } from '@github/webauthn-json/browser-ponyfill';

import type { AuthenticationPublicKeyCredential } from '@github/webauthn-json/browser-ponyfill';
import { nameKey } from '@/scripts/client-name';
import type { OpenOnRemoteOptions } from '@/scripts/please-login.js';
import { misskeyApi } from '@/scripts/misskey-api.js';
import { showSuspendedDialog } from '@/scripts/show-suspended-dialog.js';
import { login } from '@/account.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';

import XInput from '@/components/MkSignin.input.vue';
import XPassword, { type PwResponse } from '@/components/MkSignin.password.vue';
import XTotp from '@/components/MkSignin.totp.vue';
import XPasskey from '@/components/MkSignin.passkey.vue';

const emit = defineEmits<{
	(ev: 'login', v: Misskey.entities.SigninFlowResponse & { finished: true }): void;
}>();

const props = withDefaults(defineProps<{
	autoSet?: boolean;
	message?: string,
	openOnRemote?: OpenOnRemoteOptions,
}>(), {
	autoSet: false,
	message: '',
	openOnRemote: undefined,
});

const page = ref<'input' | 'password' | 'totp' | 'passkey'>('input');
const waiting = ref(false);

const passwordPageEl = useTemplateRef('passwordPageEl');
const needCaptcha = ref(false);
const useConditionalMediation = ref(false);

const userInfo = ref<null | Misskey.entities.UserDetailed>(null);
const password = ref('');
const credential = ref<null | AuthenticationPublicKeyCredential>(null);

//#region Passkey Passwordless
const credentialRequest = shallowRef<CredentialRequestOptions | null>(null);
const passkeyContext = ref('');
const doingPasskeyFromInputPage = ref(false);

const abortController = new AbortController();

if (webAuthnSupported()) {
	;(window.PublicKeyCredential?.getClientCapabilities?.().then(capabilities => capabilities.conditionalMediation) ?? window.PublicKeyCredential?.isConditionalMediationAvailable?.())
		?.then(available => {
			if (!available) return;
			useConditionalMediation.value = true;
			misskeyApi('signin-with-passkey', {}, null, abortController.signal)
				.then((response) => {
					if (abortController.signal.aborted) {
						useConditionalMediation.value = false;
						return;
					}
					const options = parseRequestOptionsFromJSON({
						mediation: 'conditional',
						publicKey: response.option,
						abortSignal: abortController.signal,
					});
					webAuthnRequest(options)
						.then(credential => {
							onConditionalMediationDone({ context: response.context, credential });
						})
						.catch(err => {
							useConditionalMediation.value = false;
							console.error(err);
							os.alert({
								type: 'error',
								text: i18n.ts.signinFailed,
							});
						});
				});
		});
}

function onPasskeyLogin(): void {
	if (webAuthnSupported()) {
		doingPasskeyFromInputPage.value = true;
		waiting.value = true;
		misskeyApi('signin-with-passkey', {})
			.then((res) => {
				passkeyContext.value = res.context ?? '';
				credentialRequest.value = parseRequestOptionsFromJSON({
					publicKey: res.option,
				});

				page.value = 'passkey';
				waiting.value = false;
			})
			.catch(onSigninApiError);
	}
}

function onConditionalMediationDone(response: { context: string, credential: AuthenticationPublicKeyCredential }): void {
	doingPasskeyFromInputPage.value = true;
	passkeyContext.value = response.context;
	onPasskeyDone(response.credential);
}

function onPasskeyDone(response: AuthenticationPublicKeyCredential): void {
	waiting.value = true;

	if (doingPasskeyFromInputPage.value) {
		misskeyApi('signin-with-passkey', {
			credential: response.toJSON(),
			context: passkeyContext.value,
		}).then(async (res) => {
			if (res.signinResponse == null) {
				onSigninApiError();
				return;
			}
			if (res.signinResponse.finished) {
				emit('login', res.signinResponse);
				await onLoginSucceeded(res.signinResponse);
			} else {
				userInfo.value = res.signinResponse.user;
				credential.value = response;
				page.value = res.signinResponse.next;
				waiting.value = false;
			}
		}).catch(onSigninApiError);
	} else if (userInfo.value != null) {
		tryLogin({
			username: userInfo.value.username,
			password: password.value,
			credential: response.toJSON(),
		});
	}
}

function onUseTotp(): void {
	page.value = 'totp';
}
//#endregion

async function onUsernameSubmitted(username: string) {
	waiting.value = true;

	userInfo.value = await misskeyApi('users/show', {
		username,
	}).catch(() => null);

	await tryLogin({
		username,
		password: password.value || undefined,
	});
}

function onPasswordProvided(pw: string) {
	password.value = pw;
}

async function onPasswordSubmitted(pw: PwResponse) {
	waiting.value = true;
	password.value = pw.password;

	if (userInfo.value == null) {
		await os.alert({
			type: 'error',
			title: i18n.ts.noSuchUser,
			text: i18n.ts.signinFailed,
		});
		waiting.value = false;
		return;
	} else {
		await tryLogin({
			username: userInfo.value.username,
			password: pw.password,
			'hcaptcha-response': pw.captcha.hCaptchaResponse,
			'm-captcha-response': pw.captcha.mCaptchaResponse,
			'g-recaptcha-response': pw.captcha.reCaptchaResponse,
			'turnstile-response': pw.captcha.turnstileResponse,
			'testcaptcha-response': pw.captcha.testcaptchaResponse,
			credential: credential.value ? credential.value.toJSON() : undefined,
		});
	}
}

async function onTotpSubmitted(token: string) {
	waiting.value = true;

	if (userInfo.value == null) {
		await os.alert({
			type: 'error',
			title: i18n.ts.noSuchUser,
			text: i18n.ts.signinFailed,
		});
		waiting.value = false;
		return;
	} else {
		await tryLogin({
			username: userInfo.value.username,
			password: password.value,
			token,
			credential: credential.value ? credential.value.toJSON() : undefined,
		});
	}
}

async function tryLogin(req: Partial<Misskey.entities.SigninFlowRequest>): Promise<Misskey.entities.SigninFlowResponse> {
	const _req = {
		username: req.username ?? userInfo.value?.username,
		capableConditionalCreate: await window.PublicKeyCredential?.getClientCapabilities?.().then(capabilities => capabilities.conditionalCreate) ?? false,
		...req,
	};

	function assertIsSigninFlowRequest(x: Partial<Misskey.entities.SigninFlowRequest>): x is Misskey.entities.SigninFlowRequest {
		return x.username != null;
	}

	if (!assertIsSigninFlowRequest(_req)) {
		throw new Error('Invalid request');
	}

	return await misskeyApi('signin-flow', _req).then(async (res) => {
		if (res.finished) {
			if (res.state && res.publicKey) {
				await os.promiseDialog(Promise.all([
					webAuthnCreate({
						publicKey: res.publicKey,
						mediation: 'conditional',
					}),
					nameKey(),
				]).then(([credential, name]) => credential
					? misskeyApi('i/2fa/key-done', {
						password: password.value,
						state: res.state,
						name: name ?? 'Auto-upgraded Passkey',
						credential: credential.toJSON(),
					}, res.i)
					: Promise.resolve() as Promise<unknown>), null, () => {});
			}
			emit('login', res);
			await onLoginSucceeded(res);
		} else {
			switch (res.next) {
				case 'captcha': {
					needCaptcha.value = true;
					page.value = 'password';
					break;
				}
				case 'password': {
					needCaptcha.value = false;
					page.value = 'password';
					break;
				}
				case 'totp': {
					page.value = 'totp';
					break;
				}
				case 'passkey': {
					if (webAuthnSupported()) {
						credentialRequest.value = parseRequestOptionsFromJSON({
							publicKey: res.authRequest,
						});
						page.value = 'passkey';
					} else {
						page.value = 'totp';
					}
					break;
				}
			}

			if (doingPasskeyFromInputPage.value === true) {
				doingPasskeyFromInputPage.value = false;
				page.value = 'input';
				password.value = '';
			}
			passwordPageEl.value?.resetCaptcha();
			nextTick(() => {
				waiting.value = false;
			});
		}
		return res;
	}).catch((err) => {
		onSigninApiError(err);
		return Promise.reject(err);
	});
}

async function onLoginSucceeded(res: Misskey.entities.SigninFlowResponse & { finished: true }) {
	if (props.autoSet) {
		await login(res.i);
	}
}

function onSigninApiError(err?: any): void {
	const id = err?.id ?? null;

	switch (id) {
		case '6cc579cc-885d-43d8-95c2-b8c7fc963280': {
			os.alert({
				type: 'error',
				title: i18n.ts.loginFailed,
				text: i18n.ts.noSuchUser,
			});
			break;
		}
		case '932c904e-9460-45b7-9ce6-7ed33be7eb2c': {
			os.alert({
				type: 'error',
				title: i18n.ts.loginFailed,
				text: i18n.ts.incorrectPassword,
			});
			break;
		}
		case 'e03a5f46-d309-4865-9b69-56282d94e1eb': {
			showSuspendedDialog();
			break;
		}
		case '22d05606-fbcf-421a-a2db-b32610dcfd1b': {
			os.alert({
				type: 'error',
				title: i18n.ts.loginFailed,
				text: i18n.ts.rateLimitExceeded,
			});
			break;
		}
		case 'cdf1235b-ac71-46d4-a3a6-84ccce48df6f': {
			os.alert({
				type: 'error',
				title: i18n.ts.loginFailed,
				text: i18n.ts.incorrectTotp,
			});
			break;
		}
		case '36b96a7d-b547-412d-aeed-2d611cdc8cdc': {
			os.alert({
				type: 'error',
				title: i18n.ts.loginFailed,
				text: i18n.ts.unknownWebAuthnKey,
			});
			break;
		}
		case '93b86c4b-72f9-40eb-9815-798928603d1e': {
			os.alert({
				type: 'error',
				title: i18n.ts.loginFailed,
				text: i18n.ts.passkeyVerificationFailed,
			});
			break;
		}
		case 'b18c89a7-5b5e-4cec-bb5b-0419f332d430': {
			os.alert({
				type: 'error',
				title: i18n.ts.loginFailed,
				text: i18n.ts.passkeyVerificationFailed,
			});
			break;
		}
		case '2d84773e-f7b7-4d0b-8f72-bb69b584c912': {
			os.alert({
				type: 'error',
				title: i18n.ts.loginFailed,
				text: i18n.ts.passkeyVerificationSucceededButPasswordlessLoginDisabled,
			});
			break;
		}
		default: {
			console.error(err);
			os.alert({
				type: 'error',
				title: i18n.ts.loginFailed,
				text: JSON.stringify(err),
			});
		}
	}

	if (doingPasskeyFromInputPage.value === true) {
		doingPasskeyFromInputPage.value = false;
		page.value = 'input';
		password.value = '';
	}
	passwordPageEl.value?.resetCaptcha();
	nextTick(() => {
		waiting.value = false;
	});
}

onBeforeUnmount(() => {
	password.value = '';
	needCaptcha.value = false;
	userInfo.value = null;
	abortController.abort();
});
</script>

<style lang="scss" module>
.transition_enterActive,
.transition_leaveActive {
	transition: opacity 0.3s cubic-bezier(0,0,.35,1), transform 0.3s cubic-bezier(0,0,.35,1);
}
.transition_enterFrom {
	opacity: 0;
	transform: translateX(50px);
}
.transition_leaveTo {
	opacity: 0;
	transform: translateX(-50px);
}

.signinRoot {
	overflow-x: hidden;
	overflow-x: clip;

	position: relative;
}

.waitingRoot {
	position: absolute;
	top: 0;
	left: 0;
	width: 100%;
	height: 100%;
	background-color: color-mix(in srgb, var(--MI_THEME-panel), transparent 50%);
	display: flex;
	justify-content: center;
	align-items: center;
	z-index: 1;
}
</style>
