import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildSignatureHeaders,
	getSignatureHeaders,
	isGatewaySignatureRejection,
	noteGatewayResponseDate,
	readGatewaySigningSecret,
	resetGatewaySigningState,
	signedGatewayFetch,
	DEFAULT_SIGNING_SECRET_FILENAME,
	SIGNING_SECRET_ENV_VAR,
	SIGNING_SECRET_FILE_ENV_VAR
} from './signing.js';

const TEST_SECRET = 'a'.repeat(64);

/** Deterministic expected signature for the shared known vector. */
function expectedSignature(method: string, path: string, ts: number): string {
	return createHmac('sha256', TEST_SECRET).update(`v1:${method}:${path}:${ts}`).digest('hex');
}

async function jsonResponse(body: unknown, status: number, date?: string): Promise<Response> {
	return new Response(JSON.stringify(body), {
		status,
		headers: date ? { date } : {}
	});
}

describe('gateway request signing', () => {
	let dataDir: string;

	beforeEach(() => {
		resetGatewaySigningState();
		// Point the default-file lookup at a scratch dir; the explicit-file
		// tests create their own. process.env.DATA_DIR is snapshotted/restored
		// because other suites in this project rely on it.
		dataDir = mkdtempSync(join(tmpdir(), 'cphg-signing-'));
		vi.stubEnv('DATA_DIR', dataDir);
		process.env[SIGNING_SECRET_ENV_VAR] = TEST_SECRET;
	});

	afterEach(() => {
		delete process.env[SIGNING_SECRET_ENV_VAR];
		delete process.env[SIGNING_SECRET_FILE_ENV_VAR];
		vi.unstubAllEnvs();
		rmSync(dataDir, { recursive: true, force: true });
		vi.restoreAllMocks();
		resetGatewaySigningState();
	});

	describe('readGatewaySigningSecret', () => {
		it('returns the trimmed secret when set', () => {
			process.env[SIGNING_SECRET_ENV_VAR] = `  ${TEST_SECRET}  `;
			expect(readGatewaySigningSecret()).toBe(TEST_SECRET);
		});

		it('treats empty and whitespace-only values as unset', () => {
			process.env[SIGNING_SECRET_ENV_VAR] = '   ';
			expect(readGatewaySigningSecret()).toBeUndefined();
		});

		it('returns undefined when the variable is absent', () => {
			delete process.env[SIGNING_SECRET_ENV_VAR];
			expect(readGatewaySigningSecret()).toBeUndefined();
		});

		it('reads the secret file named by CINEPHAGE_SIGNING_SECRET_FILE', () => {
			delete process.env[SIGNING_SECRET_ENV_VAR];
			const secretFile = join(dataDir, 'explicit.secret');
			writeFileSync(secretFile, `${'c'.repeat(64)}\n`);
			process.env[SIGNING_SECRET_FILE_ENV_VAR] = secretFile;
			expect(readGatewaySigningSecret()).toBe('c'.repeat(64));
		});

		it('falls back to {DATA_DIR}/gateway-signing.secret by default', () => {
			delete process.env[SIGNING_SECRET_ENV_VAR];
			writeFileSync(join(dataDir, DEFAULT_SIGNING_SECRET_FILENAME), `  ${'d'.repeat(64)}  `);
			expect(readGatewaySigningSecret()).toBe('d'.repeat(64));
		});

		it('prefers the env var over both file channels', () => {
			writeFileSync(join(dataDir, DEFAULT_SIGNING_SECRET_FILENAME), 'e'.repeat(64));
			process.env[SIGNING_SECRET_FILE_ENV_VAR] = join(dataDir, DEFAULT_SIGNING_SECRET_FILENAME);
			process.env[SIGNING_SECRET_ENV_VAR] = TEST_SECRET;
			expect(readGatewaySigningSecret()).toBe(TEST_SECRET);
		});

		it('prefers the explicit file over the default file', () => {
			delete process.env[SIGNING_SECRET_ENV_VAR];
			writeFileSync(join(dataDir, DEFAULT_SIGNING_SECRET_FILENAME), 'f'.repeat(64));
			const explicit = join(dataDir, 'explicit.secret');
			writeFileSync(explicit, 'a'.repeat(64));
			process.env[SIGNING_SECRET_FILE_ENV_VAR] = explicit;
			expect(readGatewaySigningSecret()).toBe('a'.repeat(64));
		});

		it('treats empty/missing files as unset', () => {
			delete process.env[SIGNING_SECRET_ENV_VAR];
			writeFileSync(join(dataDir, DEFAULT_SIGNING_SECRET_FILENAME), '   \n');
			process.env[SIGNING_SECRET_FILE_ENV_VAR] = join(dataDir, 'does-not-exist.secret');
			expect(readGatewaySigningSecret()).toBeUndefined();
		});

		it('signs requests with the file-provided secret', () => {
			delete process.env[SIGNING_SECRET_ENV_VAR];
			const fileSecret = '0'.repeat(64);
			writeFileSync(join(dataDir, DEFAULT_SIGNING_SECRET_FILENAME), fileSecret);
			const headers = getSignatureHeaders({
				method: 'GET',
				url: 'https://api.cinephage.net/api/v1/health'
			});
			const ts = Number(headers['X-Cinephage-Timestamp']);
			expect(headers['X-Cinephage-Signature']).toBe(
				createHmac('sha256', fileSecret).update(`v1:GET:/api/v1/health:${ts}`).digest('hex')
			);
		});
	});

	describe('buildSignatureHeaders', () => {
		it('matches the gateway spec known vector', () => {
			const headers = buildSignatureHeaders(TEST_SECRET, 'GET', '/api/v1/stream/123', 1730265600);
			expect(headers).toEqual({
				'X-Cinephage-Timestamp': '1730265600',
				'X-Cinephage-Signature': '258afecacf5d407b98b42a1c3a36ab0eeac7104891fd8771714250123db0acf0'
			});
		});

		it('uppercases the method before signing', () => {
			const lower = buildSignatureHeaders(TEST_SECRET, 'get', '/api/v1/health', 1730265600);
			const upper = buildSignatureHeaders(TEST_SECRET, 'GET', '/api/v1/health', 1730265600);
			expect(lower['X-Cinephage-Signature']).toBe(upper['X-Cinephage-Signature']);
		});

		it('produces a 64-char lowercase hex signature', () => {
			const headers = buildSignatureHeaders(
				TEST_SECRET,
				'POST',
				'/sys/a7x9k2m/builds',
				Date.now() / 1000
			);
			expect(headers['X-Cinephage-Signature']).toMatch(/^[0-9a-f]{64}$/);
		});
	});

	describe('getSignatureHeaders', () => {
		it('returns empty headers when no secret is configured', () => {
			delete process.env[SIGNING_SECRET_ENV_VAR];
			expect(
				getSignatureHeaders({ method: 'GET', url: 'https://api.cinephage.net/api/v1/health' })
			).toEqual({});
		});

		it('signs the pathname only, excluding the query string', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-10-30T00:00:00Z'));

			const url = 'https://api.cinephage.net/api/v1/stream/123?type=movie&refresh=1';
			const headers = getSignatureHeaders({ method: 'GET', url });
			const ts = Number(headers['X-Cinephage-Timestamp']);
			const expected = expectedSignature('GET', '/api/v1/stream/123', ts);

			expect(headers['X-Cinephage-Signature']).toBe(expected);
			// Sanity: a signature over the full URL (query included) must differ.
			const withQuery = createHmac('sha256', TEST_SECRET)
				.update(`v1:GET:${url}:${ts}`)
				.digest('hex');
			expect(headers['X-Cinephage-Signature']).not.toBe(withQuery);

			vi.useRealTimers();
		});

		it('applies the learned gateway clock offset to the timestamp', () => {
			// Gateway clock is 400 s ahead of the local clock.
			noteGatewayResponseDate(new Date(Date.now() + 400_000).toUTCString());

			const headers = getSignatureHeaders({
				method: 'GET',
				url: 'https://api.cinephage.net/api/v1/health'
			});
			const ts = Number(headers['X-Cinephage-Timestamp']);
			expect(ts).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 399);
			expect(ts).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 401);
		});

		it('resetGatewaySigningState clears the learned offset', () => {
			noteGatewayResponseDate(new Date(Date.now() + 400_000).toUTCString());
			resetGatewaySigningState();

			const headers = getSignatureHeaders({
				method: 'GET',
				url: 'https://api.cinephage.net/api/v1/health'
			});
			const ts = Number(headers['X-Cinephage-Timestamp']);
			expect(Math.abs(ts - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(1);
		});

		it('ignores malformed Date headers when learning the offset', () => {
			noteGatewayResponseDate('not-a-date');
			const headers = getSignatureHeaders({
				method: 'GET',
				url: 'https://api.cinephage.net/api/v1/health'
			});
			const ts = Number(headers['X-Cinephage-Timestamp']);
			expect(Math.abs(ts - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(1);
		});
	});

	describe('isGatewaySignatureRejection', () => {
		it('detects invalid_signature', async () => {
			const response = await jsonResponse(
				{ error: { message: 'bad sig', details: { code: 'invalid_signature' } } },
				401
			);
			expect(await isGatewaySignatureRejection(response)).toBe(true);
		});

		it('detects signature_required', async () => {
			const response = await jsonResponse(
				{ error: { message: 'sig required', details: { code: 'signature_required' } } },
				401
			);
			expect(await isGatewaySignatureRejection(response)).toBe(true);
		});

		it('returns false for other error codes', async () => {
			const response = await jsonResponse(
				{ error: { message: 'nope', details: { code: 'unknown_release' } } },
				401
			);
			expect(await isGatewaySignatureRejection(response)).toBe(false);
		});

		it('returns false for non-JSON bodies', async () => {
			const response = new Response('<html>boom</html>', { status: 401 });
			expect(await isGatewaySignatureRejection(response)).toBe(false);
		});

		it('leaves the body readable for the caller', async () => {
			const response = await jsonResponse(
				{ error: { details: { code: 'invalid_signature' } } },
				401
			);
			await isGatewaySignatureRejection(response);
			const body = (await response.json()) as { error: { details: { code: string } } };
			expect(body.error.details.code).toBe('invalid_signature');
		});
	});

	describe('signedGatewayFetch', () => {
		it('sends identity + signature headers on a successful request', async () => {
			const fetchMock = vi.fn().mockResolvedValue(await jsonResponse({ ok: true }, 200));
			vi.stubGlobal('fetch', fetchMock);

			const response = await signedGatewayFetch(
				'https://api.cinephage.net/api/v1/health',
				{ accept: 'application/json', timeoutMs: 5000 },
				async () => ({
					'X-Cinephage-Version': '0.18.0',
					...getSignatureHeaders({ method: 'GET', url: 'https://api.cinephage.net/api/v1/health' })
				})
			);

			expect(response.status).toBe(200);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			const headers = init.headers as Record<string, string>;
			expect(headers.Accept).toBe('application/json');
			expect(headers['X-Cinephage-Version']).toBe('0.18.0');
			expect(headers['X-Cinephage-Signature']).toMatch(/^[0-9a-f]{64}$/);
			expect(headers['X-Cinephage-Timestamp']).toBeDefined();
		});

		it('retries once with a fresh timestamp after a signature rejection', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-10-30T00:00:00Z'));

			const rejectionDate = new Date(Date.now() + 400_000);
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(
					await jsonResponse(
						{ error: { details: { code: 'invalid_signature' } } },
						401,
						rejectionDate.toUTCString()
					)
				)
				.mockResolvedValueOnce(await jsonResponse({ ok: true }, 200));
			vi.stubGlobal('fetch', fetchMock);

			const response = await signedGatewayFetch(
				'https://api.cinephage.net/api/v1/live/channels',
				{ accept: 'application/json', timeoutMs: 5000 },
				async () =>
					getSignatureHeaders({
						method: 'GET',
						url: 'https://api.cinephage.net/api/v1/live/channels'
					})
			);

			expect(response.status).toBe(200);
			expect(fetchMock).toHaveBeenCalledTimes(2);

			const callHeaders = (call: unknown[]): Record<string, string> =>
				(call[1] as RequestInit).headers as Record<string, string>;
			const firstTs = Number(callHeaders(fetchMock.mock.calls[0])['X-Cinephage-Timestamp']);
			const secondTs = Number(callHeaders(fetchMock.mock.calls[1])['X-Cinephage-Timestamp']);
			// Second attempt must carry the learned offset (~+400 s).
			expect(secondTs - firstTs).toBeGreaterThanOrEqual(399);
			expect(secondTs - firstTs).toBeLessThanOrEqual(401);

			vi.useRealTimers();
		});

		it('returns the retried response when the retry is also rejected', async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValue(
					await jsonResponse({ error: { details: { code: 'invalid_signature' } } }, 401)
				);
			vi.stubGlobal('fetch', fetchMock);

			const response = await signedGatewayFetch(
				'https://api.cinephage.net/api/v1/health',
				{ accept: 'application/json', timeoutMs: 5000 },
				async () => ({})
			);

			expect(response.status).toBe(401);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('does not retry non-signature 401s', async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValue(
					await jsonResponse({ error: { details: { code: 'unknown_release' } } }, 401)
				);
			vi.stubGlobal('fetch', fetchMock);

			const response = await signedGatewayFetch(
				'https://api.cinephage.net/api/v1/health',
				{ accept: 'application/json', timeoutMs: 5000 },
				async () => ({})
			);

			expect(response.status).toBe(401);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
	});
});
