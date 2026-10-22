/**
 * Credential Redaction Utilities
 *
 * Shared helpers to redact sensitive fields (API keys, passwords, tokens, etc.)
 * before returning data to the client.
 */

/** Keys whose values should be redacted in settings objects */
const SENSITIVE_KEY_PATTERNS = ['key', 'password', 'secret', 'token', 'cookie'];

/**
 * Keys that are credentials but do not match a substring pattern above.
 * SceneTime, for example, stores a `uid` and a `pass` hash; at-rest
 * encryption already treats both as secrets (EXTRA_AT_REST_KEYS in
 * crypto/secretFields.ts), so response redaction must too or the API hands
 * them back in cleartext.
 */
const SENSITIVE_EXACT_KEYS = new Set(['pass', 'uid', 'pwd', 'username', 'user']);

function isSensitiveSettingKey(key: string): boolean {
	const lowerKey = key.toLowerCase();
	if (SENSITIVE_EXACT_KEYS.has(lowerKey)) return true;
	return SENSITIVE_KEY_PATTERNS.some((pattern) => lowerKey.includes(pattern));
}

/**
 * Redact sensitive values in a settings/config object.
 * Matches keys containing any of the sensitive patterns (case-insensitive).
 *
 * @param settings - The settings object to redact
 * @returns A new object with sensitive values replaced by '[REDACTED]'
 */
export function redactSettings(
	settings: Record<string, unknown> | null | undefined
): Record<string, unknown> {
	if (!settings) return {};

	return Object.fromEntries(
		Object.entries(settings).map(([key, value]) => {
			if (isSensitiveSettingKey(key)) {
				return [key, value ? '[REDACTED]' : null];
			}
			return [key, value];
		})
	);
}

/**
 * Redact an indexer record for API responses.
 * Applies redactSettings to the indexer's settings object.
 */
export function redactIndexer<T extends { settings?: Record<string, unknown> | null }>(
	indexer: T
): T {
	return {
		...indexer,
		settings: redactSettings(indexer.settings)
	};
}
