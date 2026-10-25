import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
	CREDENTIAL_PREFIX,
	decryptCredential,
	encryptCredential,
	ensureEncryptedCredential,
	isEncryptedCredential,
	parseCredentialEnvelope,
	resetCredentialKeyCache
} from './credentialsCrypto.js';

const MASTER_A = randomBytes(32).toString('base64');
const MASTER_B = randomBytes(32).toString('base64');

function setKeyEnv(master?: string, previous?: string): void {
	resetCredentialKeyCache();
	if (master === undefined) {
		delete process.env.ENCRYPTION_MASTER_KEY;
	} else {
		process.env.ENCRYPTION_MASTER_KEY = master;
	}
	if (previous === undefined) {
		delete process.env.ENCRYPTION_PREVIOUS_KEYS;
	} else if (previous === '') {
		delete process.env.ENCRYPTION_PREVIOUS_KEYS;
	} else {
		process.env.ENCRYPTION_PREVIOUS_KEYS = previous;
	}
}

afterEach(() => {
	setKeyEnv();
});

describe('credentialsCrypto envelope', () => {
	it('round-trips a credential under the same purpose and record id', () => {
		setKeyEnv(MASTER_A);
		const stored = encryptCredential('dl-client-password', 'client-1', 's3cret!');
		expect(stored.startsWith(CREDENTIAL_PREFIX)).toBe(true);
		expect(decryptCredential('dl-client-password', 'client-1', stored)).toBe('s3cret!');
	});

	it('binds ciphertext to the record id via AAD (relocation fails)', () => {
		setKeyEnv(MASTER_A);
		const stored = encryptCredential('dl-client-password', 'client-1', 's3cret!');
		expect(decryptCredential('dl-client-password', 'client-2', stored)).toBeNull();
	});

	it('binds ciphertext to the purpose via HKDF domain separation', () => {
		setKeyEnv(MASTER_A);
		const stored = encryptCredential('subtitle-provider', 'row-1', 'tok');
		expect(decryptCredential('nntp-server', 'row-1', stored)).toBeNull();
	});

	it('produces distinct ciphertexts for the same plaintext across records', () => {
		setKeyEnv(MASTER_A);
		const a = encryptCredential('setting', 'tmdb_api_key', 'same');
		const b = encryptCredential('setting', 'tmdb_api_key', 'same');
		expect(a).not.toBe(b); // fresh nonce per encryption
	});

	it('fails closed after a key change without a previous-key fallback', () => {
		setKeyEnv(MASTER_A);
		const stored = encryptCredential('setting', 'tmdb_api_key', 'key');
		setKeyEnv(MASTER_B);
		expect(decryptCredential('setting', 'tmdb_api_key', stored)).toBeNull();
	});

	it('decrypts after rotation through ENCRYPTION_PREVIOUS_KEYS (bare entry)', () => {
		setKeyEnv(MASTER_A);
		const stored = encryptCredential('setting', 'tmdb_api_key', 'key');
		setKeyEnv(MASTER_B, MASTER_A);
		expect(decryptCredential('setting', 'tmdb_api_key', stored)).toBe('key');
	});

	it('decrypts after rotation through a kid-tagged previous entry', () => {
		setKeyEnv(MASTER_A);
		const stored = encryptCredential('setting', 'tmdb_api_key', 'key');
		const kid = parseCredentialEnvelope(stored)?.kid;
		expect(kid).toBe('k1');
		setKeyEnv(MASTER_B, `k1:${MASTER_A}`);
		expect(decryptCredential('setting', 'tmdb_api_key', stored)).toBe('key');
	});

	it('keeps pre-rotation values decryptable via fallback while new writes use the new key', () => {
		setKeyEnv(MASTER_A);
		const old = encryptCredential('setting', 'tmdb_api_key', 'key');
		setKeyEnv(MASTER_B, MASTER_A);
		const rotated = ensureEncryptedCredential('setting', 'tmdb_api_key', old);
		expect(rotated).toBe(old); // already enveloped — not double-encrypted
		const decrypted = decryptCredential('setting', 'tmdb_api_key', rotated);
		expect(decrypted).toBe('key');
	});

	it('does not double-encrypt already-enveloped values', () => {
		setKeyEnv(MASTER_A);
		const once = encryptCredential('setting', 'x', 'v');
		expect(ensureEncryptedCredential('setting', 'x', once)).toBe(once);
	});

	it('detects ciphertext exactly, unlike the legacy hex-triplet heuristic', () => {
		setKeyEnv(MASTER_A);
		const stored = encryptCredential('setting', 'x', 'v');
		expect(isEncryptedCredential(stored)).toBe(true);
		// Legacy apiKeyCrypto/debridTokenCrypto blobs must NOT match the new prefix.
		expect(isEncryptedCredential('a1b2c3d4:e5f6a7b8:0123456789abcdef')).toBe(false);
		expect(isEncryptedCredential('plaintext password')).toBe(false);
		expect(isEncryptedCredential('')).toBe(false);
		expect(isEncryptedCredential(null)).toBe(false);
		expect(isEncryptedCredential(12345)).toBe(false);
	});

	it('rejects malformed envelopes', () => {
		expect(isEncryptedCredential('cphg1.')).toBe(false);
		expect(isEncryptedCredential('cphg1.k1')).toBe(false);
		expect(isEncryptedCredential('cphg1.k1.')).toBe(false);
		expect(isEncryptedCredential('cphg1.k1.!!not-base64!!')).toBe(false);
		expect(isEncryptedCredential('cphg1.bad kid.AAAA')).toBe(false);
		// Payload shorter than nonce+tag is not parseable.
		expect(isEncryptedCredential('cphg1.k1.AAAA')).toBe(false);
		expect(parseCredentialEnvelope('cphg1.k1.AAAA')).toBeNull();
	});

	it('decrypts empty-string plaintexts round-trip', () => {
		setKeyEnv(MASTER_A);
		const stored = encryptCredential('nntp-server', 'srv-1', '');
		expect(decryptCredential('nntp-server', 'srv-1', stored)).toBe('');
	});
});
