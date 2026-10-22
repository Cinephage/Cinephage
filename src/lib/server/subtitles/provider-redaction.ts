/**
 * Redaction for subtitle provider API responses.
 *
 * `rowToConfig` decrypts the stored credential columns before returning, so
 * every route that serialises a provider must redact — GET, POST and PUT
 * alike. The single-provider GET previously spread `...provider`, which
 * returned the decrypted `settings` object (where definition keys like
 * `token` live) even though the top-level fields were redacted.
 */

const REDACTED = '[REDACTED]';

export interface SubtitleProviderLike {
	apiKey?: string | null;
	username?: string | null;
	password?: string | null;
	settings?: Record<string, unknown> | null;
}

function isSecretSettingKey(key: string): boolean {
	const lower = key.toLowerCase();
	return (
		lower.includes('key') ||
		lower.includes('password') ||
		lower.includes('secret') ||
		lower.includes('token')
	);
}

/** Redact a settings object's secret-looking values. */
export function redactProviderSettings(
	settings: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
	if (!settings) return null;
	return Object.fromEntries(
		Object.entries(settings).map(([key, value]) => [
			key,
			isSecretSettingKey(key) ? (value ? REDACTED : null) : value
		])
	);
}

/** Redact a provider for an API response. */
export function redactSubtitleProvider<T extends SubtitleProviderLike>(provider: T): T {
	return {
		...provider,
		apiKey: provider.apiKey ? REDACTED : null,
		password: provider.password ? REDACTED : null,
		settings: redactProviderSettings(provider.settings)
	};
}
