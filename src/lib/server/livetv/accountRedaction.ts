/**
 * Live TV account response redaction.
 *
 * Provider configs carry portal credentials (stalker token/password, Xtream
 * password/auth token). API responses never ship them: the edit form omits
 * unchanged secrets and the test endpoint resolves stored values server-side
 * by accountId, so `[REDACTED]` round-trips cleanly. Usernames stay visible —
 * the edit form prefills them and they double as account identifiers.
 */

import { REDACTED_VALUE } from '#lib/shared/sensitiveSettings.js';
import type { LiveTvAccount } from '#lib/types/livetv.js';

function redact(value: string | undefined): string | undefined {
	return value ? REDACTED_VALUE : value;
}

function redactHeaders(
	headers: Record<string, string> | undefined
): Record<string, string> | undefined {
	if (!headers) return headers;
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		out[name] = value ? REDACTED_VALUE : value;
	}
	return out;
}

export function redactAccountSecrets(account: LiveTvAccount): LiveTvAccount {
	if (account.stalkerConfig) {
		account = {
			...account,
			stalkerConfig: {
				...account.stalkerConfig,
				token: redact(account.stalkerConfig.token),
				password: redact(account.stalkerConfig.password)
			}
		};
	}
	if (account.xstreamConfig) {
		account = {
			...account,
			xstreamConfig: {
				...account.xstreamConfig,
				password: redact(account.xstreamConfig.password) ?? '',
				authToken: redact(account.xstreamConfig.authToken),
				epgUrl: redact(account.xstreamConfig.epgUrl)
			}
		};
	}
	if (account.m3uConfig) {
		account = {
			...account,
			m3uConfig: {
				...account.m3uConfig,
				// m3u URLs commonly embed user:pass@host credentials.
				url: redact(account.m3uConfig.url),
				epgUrl: redact(account.m3uConfig.epgUrl),
				headers: redactHeaders(account.m3uConfig.headers)
			}
		};
	}
	return account;
}
