import {
	encryptSecretJsonValues,
	decryptSecretJsonValues,
	isAtRestSecretKeyName
} from '#lib/server/crypto/secretFields.js';

/**
 * At-rest encryption for LiveTV provider config JSONs (stalker/xstream/m3u).
 * Credential fields (username/password/token/authToken via the shared
 * predicate; m3u `url`/`headers` explicitly — URLs embed user:pass) are
 * enveloped per-field; everything else stays plaintext.
 */

const LIVETV_CONFIG_PURPOSE = 'livetv-config';
const M3U_EXTRA_SECRET_KEYS = ['url', 'headers'];

function isLivetvSecretKey(key: string): boolean {
	return isAtRestSecretKeyName(key) || M3U_EXTRA_SECRET_KEYS.includes(key);
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
