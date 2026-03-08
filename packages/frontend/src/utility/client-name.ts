import { decode } from 'cbor2';
import aaguids from 'aaguids';

const ICLOUD_KEYCHAIN = 'iCloud Keychain';

declare global {
	interface Uint8ArrayConstructor {
		fromBase64(base64: string): Uint8Array;
	}
}

function extractAaguidFromAttestation(attestationObject: string): string | null {
	try {
		const { authData } = decode<{ readonly authData?: Uint8Array }>(Uint8Array.fromBase64(attestationObject));

		if (!authData || authData.length < 53) {
			return null;
		}

		const flags = authData[32];
		const hasAttestedCredentialData = (flags & 0x40) !== 0;

		if (!hasAttestedCredentialData) {
			return null;
		}

		const aaguidBytes = authData.slice(37, 53);

		const hex = Array.from(aaguidBytes)
			.map(b => b.toString(16).padStart(2, '0'))
			.join('');

		return [
			hex.slice(0, 8),
			hex.slice(8, 12),
			hex.slice(12, 16),
			hex.slice(16, 20),
			hex.slice(20, 32),
		].join('-');
	} catch (err) {
		console.warn('[nameKey] Failed to extract AAGUID:', err);
		return null;
	}
}

function fromAaguid(aaguid?: string | null): string | null {
	if (!aaguid) return null;
	const normalized = aaguid.toLowerCase();
	return aaguids[normalized] ?? null;
}

export async function nameKey(attestationObject?: string | null): Promise<string | null> {
	const aaguid = attestationObject ? extractAaguidFromAttestation(attestationObject) : null;

	const mapped = fromAaguid(aaguid);
	if (mapped) {
		return mapped;
	}

	if (navigator.userAgentData) {
		const result = await navigator.userAgentData.getHighEntropyValues(['model'])
			.then(ua => (ua as unknown as { readonly model: string }).model || (ua as unknown as { readonly platform: string }).platform, () => navigator.userAgentData!.platform);
		if (result === 'macOS') {
			return ICLOUD_KEYCHAIN;
		}
		if (result) {
			return result;
		}
	}
	switch (navigator.platform) {
		case 'MacIntel':
		case 'iPad':
		case 'iPhone':
			return ICLOUD_KEYCHAIN;
		default:
			return null;
	}
}
