import { describe, expect, it } from 'vitest';
import { __testing } from './index.js';

const { isSensitiveObjectKey, redactString } = __testing;

/**
 * Regression coverage: the redaction predicate matched exact names and
 * `_`/`-` suffixes only, so camelCase compounds — the exact shape this
 * codebase uses in log payloads — passed through unredacted. SessionProxyService
 * logged `sessionToken: session.token` on every proxied playback segment.
 */
describe('log redaction', () => {
	it.each([
		'apiKey',
		'api_key',
		'api-key',
		'apiToken',
		'authToken',
		'accessToken',
		'refreshToken',
		'sessionToken',
		'adminPassword',
		'proxyPassword',
		'clientSecret',
		'indexerApiKey',
		'password',
		'cookie'
	])('treats %s as sensitive', (key) => {
		expect(isSensitiveObjectKey(key)).toBe(true);
	});

	it.each([
		'title',
		'path',
		'resourceUrl',
		'provider',
		'contentType',
		'aggregate',
		'usemagnetlinks'
	])('leaves %s alone', (key) => {
		expect(isSensitiveObjectKey(key)).toBe(false);
	});

	it('redacts camelCase key/value pairs in log strings', () => {
		expect(redactString('sessionToken=abc123 provider=real-debrid')).toBe(
			'sessionToken=[REDACTED] provider=real-debrid'
		);
		expect(redactString('apiToken: xyz789')).toBe('apiToken=[REDACTED]');
	});

	it('still redacts query params and URL userinfo', () => {
		expect(redactString('GET /api/x?api_key=secret123&page=2')).toBe(
			'GET /api/x?api_key=[REDACTED]&page=2'
		);
		expect(redactString('http://user:pass@host/path')).toBe(
			'http://[REDACTED]:[REDACTED]@host/path'
		);
	});
});
