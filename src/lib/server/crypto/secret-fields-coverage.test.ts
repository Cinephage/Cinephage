import { describe, expect, it } from 'vitest';
import { findSecretFieldSpec, isAtRestSecretKeyName } from './secretFields.js';
import { encryptLivetvConfig, decryptLivetvConfig } from '../livetv/configCrypto.js';
import { randomBytes } from 'node:crypto';

/**
 * The runtime encryptors and the rotation registry must agree on which keys
 * are secret. Rotation decrypts a row, then re-encrypts using the registry's
 * key predicate; a key the runtime encrypted but the registry does not know
 * about comes back as plaintext and is persisted that way.
 */
describe('secret registry vs runtime encryptors', () => {
	it('registers every LiveTV config key the runtime encrypts', () => {
		process.env.ENCRYPTION_MASTER_KEY = randomBytes(32).toString('base64');
		try {
			const spec = findSecretFieldSpec('livetv_accounts')!;
			expect(spec).toBeDefined();

			const probe = {
				username: 'user',
				password: 'pass',
				token: 'tok',
				authToken: 'auth',
				url: 'http://user:pass@host/playlist.m3u',
				headers: { Authorization: 'Bearer x' },
				epgUrl: 'http://user:pass@host/epg.xml',
				fileContent: '#EXTM3U\n#EXTINF:1,Chan\nhttp://user:pass@host/1.ts'
			};

			const encrypted = encryptLivetvConfig('acct-1', probe) as Record<string, unknown>;
			const registrySecrets = new Set<string>();
			for (const field of spec.jsonFields ?? []) {
				for (const key of Object.keys(probe)) {
					if (isAtRestSecretKeyName(key) || (field.extraKeys ?? []).includes(key)) {
						registrySecrets.add(key);
					}
				}
			}

			for (const key of Object.keys(probe)) {
				const value = encrypted[key];
				const encryptsAtRuntime = typeof value === 'string' && value.startsWith('cphg1.');
				if (encryptsAtRuntime) {
					expect(registrySecrets, `${key} encrypted at runtime but not registered`).toContain(key);
				}
			}

			// And it must round-trip through the registry-driven decryptor.
			expect(decryptLivetvConfig('acct-1', encrypted)).toEqual(probe);
		} finally {
			delete process.env.ENCRYPTION_MASTER_KEY;
		}
	});

	it('encrypts subtitle provider definition tokens stored in settings', () => {
		const spec = findSecretFieldSpec('subtitle_providers')!;
		const fields = new Set(
			(spec.jsonFields ?? []).map((field) => field.column.replace(/_/g, '').toLowerCase())
		);
		expect(fields).toContain('settings');
	});
});
