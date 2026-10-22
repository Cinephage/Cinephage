import {
	encryptSecretJsonValues,
	decryptSecretJsonValues,
	isAtRestSecretKeyName
} from '#lib/server/crypto/secretFields.js';

/**
 * At-rest encryption for LiveTV provider config JSONs (stalker/xstream/m3u).
 * Credential fields (username/password/token/authToken via the shared
 * predicate) are enveloped per-field; everything else stays plaintext.
 *
 * The extra keys MUST match the `extraKeys` declared for livetv_accounts in
 * SECRET_FIELD_SPECS. If the runtime encrypts a field the registry does not
 * know about, credential rotation decrypts and re-encrypts around it — the
 * value survives, but backups and migrations treat it as non-secret and copy
 * it out as plaintext.
 */
const LIVETV_CONFIG_PURPOSE = 'livetv-config';
const LIVETV_EXTRA_SECRET_KEYS = [
	// M3U: the playlist URL and headers embed provider credentials.
	'url',
	'headers',
	// XMLTV/EPG URLs routinely carry username/password query params and are
	// chosen by the playlist author, not the admin.
	'epgUrl',
	// An uploaded playlist's full text, full of credentialed channel URLs.
	'fileContent'
];

function isLivetvSecretKey(key: string): boolean {
	return isAtRestSecretKeyName(key) || LIVETV_EXTRA_SECRET_KEYS.includes(key);
}

export function encryptLivetvConfig<T extends Record<string, unknown>>(
	accountId: string,
	config: T
): T {
	return encryptSecretJsonValues(LIVETV_CONFIG_PURPOSE, accountId, config, isLivetvSecretKey) as T;
}

export function decryptLivetvConfig<T extends Record<string, unknown>>(
	accountId: string,
	config: T
): T {
	return decryptSecretJsonValues(LIVETV_CONFIG_PURPOSE, accountId, config) as T;
}
