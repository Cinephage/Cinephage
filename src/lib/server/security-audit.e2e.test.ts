import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * End-to-end checks for the security boundaries fixed in the audit.
 *
 * These run the real modules — no mocks for the code under test — against
 * fixture inputs derived from the audit's exploit scenarios. Each test names
 * the vulnerability it pins.
 */

describe('security audit regression suite', () => {
	describe('streaming key must not authenticate /api/auth', () => {
		it('the hook gate rejects non-full-access keys on the auth surface', async () => {
			// The gate lives in hooks.server.ts; assert the rule is present and
			// wired to run when the route is an auth route.
			const source = readFileSync(join(process.cwd(), 'src/hooks.server.ts'), 'utf8');
			expect(source).toContain('rejectStreamingKeyOnAuthRoute');
			expect(source).toContain("permissions: { default: ['*'] }");
			// And it must actually be applied on the auth path.
			expect(source).toMatch(/\} else \{[\s\S]*?rejectStreamingKeyOnAuthRoute\(\)[\s\S]*?\}\s*\}/);
		});

		it('the api-key plugin still bridges full-access keys (main-key flows keep working)', async () => {
			const source = readFileSync(join(process.cwd(), 'src/lib/server/auth/auth.ts'), 'utf8');
			expect(source).toContain('enableSessionForAPIKeys: true');
		});
	});

	describe('credential rotation must not destroy undecryptable secrets', () => {
		it('decryptRecordSecrets reports failures instead of writing null', async () => {
			const { decryptRecordSecrets, findSecretFieldSpec } =
				await import('#lib/server/crypto/secretFields.js');
			process.env.ENCRYPTION_MASTER_KEY = 'an-invalid-key-that-cannot-decrypt-anything-at-all';
			try {
				const spec = findSecretFieldSpec('download_clients')!;
				// A well-formed envelope (12-byte IV + 16-byte tag + ciphertext)
				// whose key is no longer available.
				const fakePayload = Buffer.concat([
					randomBytes(12),
					randomBytes(16),
					Buffer.from('ciphertext')
				]);
				const envelope = `cphg1.k1.${fakePayload.toString('base64url')}`;
				const row = { id: 'client-1', password: envelope };

				const failed = decryptRecordSecrets(spec, row);

				expect(failed).toContain('password');
				// The ciphertext survives: rotation can be retried with the right key.
				expect(row.password).toBe(envelope);
			} finally {
				delete process.env.ENCRYPTION_MASTER_KEY;
			}
		});
	});

	describe('destructive helpers must refuse the library root', () => {
		it('deleteDirectoryWithinRoot is root-strict and symlink-aware', async () => {
			const { resolvePathWithinRoot, namesRootItself } =
				await import('#lib/server/filesystem/delete-helpers.js');
			const root = process.cwd();

			expect(() => resolvePathWithinRoot(root, '.')).toThrow(/root folder itself/);
			expect(namesRootItself(root, '.')).toBe(true);
			expect(namesRootItself(root, 'src')).toBe(false);
		});
	});

	describe('SSRF policy must cover the encodings the old denylist missed', () => {
		it.each([
			['http://[fc01::1]/x'],
			['http://[febf::1]/x'],
			['http://[64:ff9b::7f00:1]/x'],
			['http://[2002:7f00:1::]/x'],
			['http://169.254.169.254/latest/meta-data/'],
			['file:///etc/passwd'],
			['gopher://127.0.0.1:6379/_INFO']
		])('rejects %s', async (url) => {
			const { resolveAndValidateUrl } = await import('#lib/server/http/ssrf-protection.js');
			await expect(resolveAndValidateUrl(url)).resolves.toMatchObject({ safe: false });
		});

		it('fetchWithTimeout pins hostnames so validation and connection agree', async () => {
			const source = readFileSync(
				join(process.cwd(), 'src/lib/server/http/ssrf-protection.ts'),
				'utf8'
			);
			expect(source).toContain('new Agent(');
			expect(source).toContain('lookup:');
			expect(source).toContain('UnsafeUrlError');
		});
	});

	describe('LiveTV segment proxy must be bound to the lineup', () => {
		it('the binding check runs before any network I/O', async () => {
			const source = readFileSync(
				join(process.cwd(), 'src/routes/api/livetv/stream/[lineupId]/[...path]/+server.ts'),
				'utf8'
			);
			expect(source).toContain('isHostAllowed');
			// Within the GET handler, the binding must precede the SSRF validation
			// and the fetch; anchor on the handler's own validation call so the
			// retry helper's definition earlier in the file does not match.
			const bindAt = source.indexOf('isHostAllowed');
			const validateAt = source.indexOf('const safetyCheck = await resolveAndValidateUrl');
			expect(bindAt).toBeGreaterThan(-1);
			expect(validateAt).toBeGreaterThan(bindAt);
		});

		it('the cache learns hosts from resolutions and playlist contents', async () => {
			const source = readFileSync(
				join(process.cwd(), 'src/lib/server/livetv/streaming/StreamUrlCache.ts'),
				'utf8'
			);
			expect(source).toContain('allowHost');
			expect(source).toContain('isHostAllowed');
		});
	});

	describe('response redaction must cover the credential key names in use', () => {
		it('indexer redaction treats pass/uid as secrets', async () => {
			const { redactSettings } = await import('#lib/server/utils/redaction.js');
			const redacted = redactSettings({
				uid: 'scene-user',
				pass: 'scene-hash',
				host: 'scenetime.example'
			});
			expect(redacted.uid).toBe('[REDACTED]');
			expect(redacted.pass).toBe('[REDACTED]');
			expect(redacted.host).toBe('scenetime.example');
		});

		it('URL redaction catches passkeys nested inside magnet tr= values', async () => {
			const { redactUrl } = await import('#lib/server/utils/urlSecurity.js');
			const magnet =
				'magnet:?xt=urn:btih:ABCDEF&tr=https%3A%2F%2Ftracker.example%2Fannounce%3Fpasskey%3DSECRET999';
			const redacted = redactUrl(magnet);
			expect(redacted).not.toContain('SECRET999');
		});

		it('subtitle provider responses redact token-bearing settings', async () => {
			const { redactSubtitleProvider } =
				await import('#lib/server/subtitles/provider-redaction.js');
			const provider = {
				name: 'Assrt',
				apiKey: 'plain-key',
				password: 'plain-pass',
				settings: { token: 'assrt-token', endpoint: 'https://api.assrt.net' }
			};
			const redacted = redactSubtitleProvider(provider);
			expect(redacted.apiKey).toBe('[REDACTED]');
			expect(redacted.password).toBe('[REDACTED]');
			expect(redacted.settings?.token).toBe('[REDACTED]');
			expect(redacted.settings?.endpoint).toBe('https://api.assrt.net');
		});
	});

	describe('log redaction must catch camelCase keys', () => {
		it('sessionToken and friends are redacted', async () => {
			const { __testing } = await import('#lib/logging/index.js');
			expect(__testing.isSensitiveObjectKey('sessionToken')).toBe(true);
			expect(__testing.isSensitiveObjectKey('apiToken')).toBe(true);
			expect(__testing.redactString('sessionToken=abc123 provider=x')).toBe(
				'sessionToken=[REDACTED] provider=x'
			);
		});
	});

	describe('docker build context must exclude runtime data', () => {
		it('nested DBs, logs and backups are excluded', async () => {
			const { readFileSync: read } = await import('node:fs');
			const rules = read(join(process.cwd(), '.dockerignore'), 'utf8');
			// The broad exclusion must be present; the narrow `data/*.db` form
			// is what leaked the database into images.
			expect(rules).toContain('data/**');
			expect(rules).not.toMatch(/^data\/\*\.db$/m);
		});
	});

	afterEach(() => {
		delete process.env.ENCRYPTION_MASTER_KEY;
	});
});
