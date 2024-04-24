const ICLOUD_KEYCHAIN = 'iCloud Keychain';

export async function nameKey(): Promise<string | null> {
	if (window.navigator.userAgentData) {
		const result = await window.navigator.userAgentData.getHighEntropyValues(['model'])
			.then(
				ua => {
					return ua.model || ua.platform;
				},
				() => {
					return window.navigator.userAgentData.platform;
				},
			);
		if (result === 'macOS') {
			return ICLOUD_KEYCHAIN;
		}
		if (result) {
			return result;
		}
	}
	switch (window.navigator.platform) {
		case 'MacIntel':
		case 'iPad':
		case 'iPhone':
			return ICLOUD_KEYCHAIN;
		default:
			return null;
	}
}
