import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

import { readFileSync } from 'node:fs';
import { logger } from '#lib/logging/index.js';
import { getAuthSecret } from '../auth/secret.js';

/**
 * Versioned AEAD envelope for credentials stored at rest.
 *
 * Design (docs/superpowers/specs/2026-10-06-credential-encryption-design.md):
 * AES-256-GCM via node:crypto (12-byte random IV, 128-bit auth tag),
 * HKDF-SHA256 deriving one purpose-bound key per key-id (RFC 5869 `info`
 * labels; the master secret is high-entropy by construction, so a slow KDF
 * would buy nothing), AAD binding `purpose:recordId` so a ciphertext can
 * never be relocated between rows undetected, and a self-describing
 * `cphg1.<kid>.<base64url(...)>` prefix that replaces heuristic ciphertext
 * detection and leaves room for key rotation via ENCRYPTION_PREVIOUS_KEYS.
 *
 * XChaCha20-Poly1305 (@noble/ciphers) is the documented future alternative
 * if a dependency is ever acceptable; it is deliberately not used here.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/** Non-secret HKDF salt; entropy comes from the master secret itself. */
const HKDF_SALT = 'cinephage-credentials-v1';

/** Envelope format marker: `cphg1.<kid>.<base64url(nonce|tag|ct)>`. */
export const CREDENTIAL_PREFIX = 'cphg1.';

/** Key id of the current/master key. Bump when a rotation era begins. */
const CURRENT_KID = 'k1';

interface MasterKey {
	kid: string;
	secret: string;
}
interface KeyCacheEntry {
	key: Buffer;
}

let custodyLogged = false;
const keyCache = new Map<string, KeyCacheEntry>();

function readSecretFile(path: string): string {
	const content = readFileSync(path, 'utf8').trim();
	if (!content) {
		throw new Error(`ENCRYPTION_MASTER_KEY_FILE (${path}) is empty`);
	}
	return content;
}

function readEnvSecret(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

/**
 * Resolve key custody: dedicated ENCRYPTION_MASTER_KEY (or _FILE, for
 * Docker-secret style mounts) when present, otherwise derived from
 * BETTER_AUTH_SECRET so existing installs upgrade with zero configuration.
 */
function getMasterKey(): MasterKey {
	const dedicated = readEnvSecret('ENCRYPTION_MASTER_KEY');
	if (dedicated) {
		logCustodyOnce('dedicated ENCRYPTION_MASTER_KEY');
		return { kid: CURRENT_KID, secret: dedicated };
	}

	const file = readEnvSecret('ENCRYPTION_MASTER_KEY_FILE');
	if (file) {
		const secret = readSecretFile(file);
		logCustodyOnce(`ENCRYPTION_MASTER_KEY_FILE (${file})`);
		return { kid: CURRENT_KID, secret };
	}

	logCustodyOnce('fallback derivation from BETTER_AUTH_SECRET');
	return { kid: CURRENT_KID, secret: getAuthSecret() };
}

function logCustodyOnce(mode: string): void {
	if (custodyLogged) return;
	custodyLogged = true;
	if (process.env.VITE_SSR_BUILD || process.env.VITEST) return;
	logger.info(
		{ component: 'CredentialsCrypto', logDomain: 'system' },
		`[CredentialsCrypto] Credential encryption key custody: ${mode}`
	);
}

/**
 * Parse ENCRYPTION_PREVIOUS_KEYS entries (`kid:secret` or bare `secret`) into
 * fallback keys tried after the current key during decryption.
 */
function getPreviousKeys(): MasterKey[] {
	const raw = readEnvSecret('ENCRYPTION_PREVIOUS_KEYS');
	if (!raw) return [];
	return raw
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const colon = entry.indexOf(':');
			// A bare secret may itself contain colons; only split when the
			// prefix looks like a key id (short, alphanumeric).
			if (colon > 0 && colon <= 4 && /^[a-z0-9]+$/i.test(entry.slice(0, colon))) {
				return { kid: entry.slice(0, colon), secret: entry.slice(colon + 1) };
			}
			return { kid: 'unknown', secret: entry };
		});
}

function deriveKey(master: MasterKey, purpose: string, kid: string): Buffer {
	const cacheKey = `${fingerprint(master.secret)}:${purpose}:${kid}`;
	const cached = keyCache.get(cacheKey);
	if (cached) return cached.key;

	const key = Buffer.from(
		hkdfSync(
			'sha256',
			Buffer.from(master.secret, 'utf8'),
			HKDF_SALT,
			Buffer.from(`cinephage/${purpose}/${kid}`, 'utf8'),
			KEY_LENGTH
		)
	);
	keyCache.set(cacheKey, { key });
	return key;
}

function fingerprint(secret: string): string {
	return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

/** Test hook: forget cached derived keys (secret rotation / env changes). */
export function resetCredentialKeyCache(): void {
	keyCache.clear();
}

export interface CredentialEnvelope {
	kid: string;
	nonce: Buffer;
	authTag: Buffer;
	ciphertext: Buffer;
}

/** Parse the `cphg1.<kid>.<b64url>` envelope shape without decrypting. */
export function parseCredentialEnvelope(value: string): CredentialEnvelope | null {
	if (!value.startsWith(CREDENTIAL_PREFIX)) return null;
	const rest = value.slice(CREDENTIAL_PREFIX.length);
	const dot = rest.indexOf('.');
	if (dot <= 0) return null;
	const kid = rest.slice(0, dot);
	if (!/^[a-z0-9]+$/i.test(kid)) return null;

	let payload: Buffer;
	try {
		payload = Buffer.from(rest.slice(dot + 1), 'base64url');
	} catch {
		return null;
	}
	if (payload.length < IV_LENGTH + AUTH_TAG_LENGTH) return null;

	return {
		kid,
		nonce: payload.subarray(0, IV_LENGTH),
		authTag: payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH),
		ciphertext: payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
	};
}

/** Exact ciphertext detection: the versioned prefix plus a parseable body. */
export function isEncryptedCredential(value: unknown): value is string {
	return typeof value === 'string' && parseCredentialEnvelope(value) !== null;
}

function aadFor(purpose: string, recordId: string): Buffer {
	return Buffer.from(`${purpose}:${recordId}`, 'utf8');
}

/**
 * Encrypt a credential for a given purpose and owning record. The returned
 * envelope is bound to `${purpose}:${recordId}` via AAD and to the current
 * key via its kid.
 */
export function encryptCredential(purpose: string, recordId: string, plaintext: string): string {
	const master = getMasterKey();
	const key = deriveKey(master, purpose, master.kid);
	const nonce = randomBytes(IV_LENGTH);

	const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: AUTH_TAG_LENGTH });
	cipher.setAAD(aadFor(purpose, recordId));
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const authTag = cipher.getAuthTag();

	const payload = Buffer.concat([nonce, authTag, ciphertext]);
	return `${CREDENTIAL_PREFIX}${master.kid}.${payload.toString('base64url')}`;
}

/** Encrypt unless the value already carries an envelope (idempotent for migrations/re-saves). */
export function ensureEncryptedCredential(
	purpose: string,
	recordId: string,
	value: string
): string {
	if (isEncryptedCredential(value)) return value;
	return encryptCredential(purpose, recordId, value);
}

/**
 * Decrypt a credential. Tries the envelope's key id first, then the current
 * key, then the ENCRYPTION_PREVIOUS_KEYS fallback list. Returns null (with a
 * loud, contextual error log) when nothing decrypts — callers fail closed.
 */
export function decryptCredential(
	purpose: string,
	recordId: string,
	stored: string,
	context?: string
): string | null {
	const envelope = parseCredentialEnvelope(stored);
	if (!envelope) return null;

	const candidates: MasterKey[] = [];
	const current = getMasterKey();
	if (current.kid === envelope.kid) candidates.push(current);
	for (const previous of getPreviousKeys()) {
		if (previous.kid === envelope.kid || previous.kid === 'unknown') candidates.push(previous);
	}
	if (!candidates.includes(current)) candidates.push(current);
	for (const previous of getPreviousKeys()) {
		if (!candidates.includes(previous)) candidates.push(previous);
	}

	for (const master of candidates) {
		try {
			// Derive with the ENVELOPE's key id: that is the era the blob was
			// encrypted under, regardless of how the fallback entry was labeled.
			const key = deriveKey(master, purpose, envelope.kid);
			const decipher = createDecipheriv(ALGORITHM, key, envelope.nonce, {
				authTagLength: AUTH_TAG_LENGTH
			});
			decipher.setAAD(aadFor(purpose, recordId));
			decipher.setAuthTag(envelope.authTag);
			const plaintext = Buffer.concat([
				decipher.update(envelope.ciphertext),
				decipher.final()
			]).toString('utf8');
			return plaintext;
		} catch {
			// Wrong key, wrong record binding, or corruption — try the next candidate.
		}
	}

	logger.error(
		{
			component: 'CredentialsCrypto',
			logDomain: 'system',
			purpose,
			recordId,
			kid: envelope.kid,
			context
		},
		'[CredentialsCrypto] Stored credential failed to decrypt — the value is being dropped. ' +
			'If the encryption master key was rotated, set ENCRYPTION_PREVIOUS_KEYS or re-enter the credential.'
	);
	return null;
}
