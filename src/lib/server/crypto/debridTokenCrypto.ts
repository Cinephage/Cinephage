import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { logger } from '#lib/logging/index.js';
import { getAuthSecret } from '../auth/secret.js';

const ALGORITHM = 'aes-256-gcm';

/**
 * Salt label for debrid token key derivation.
 * Distinct from apiKeyCrypto's 'cinephage-api-key-v1' so the derived keys differ.
 */
const SALT_LABEL = 'cinephage-debrid-token-v1';

/**
 * Derive encryption key from Better Auth secret using a distinct salt label.
 *
 * NOTE: This intentionally does not cache the derived key. Caching would break
 * the portable-backup test cases (and any runtime secret rotation) because the
 * derived key must change whenever BETTER_AUTH_SECRET changes. The performance
 * cost of scrypt per encrypt/decrypt operation is acceptable for the rare
 * debrid-token workflows.
 */
function getEncryptionKey(): Buffer {
	const secret = getAuthSecret();
	return scryptSync(secret, SALT_LABEL, 32);
}

/**
 * Encrypt a debrid API token using AES-256-GCM.
 * Returns string in format: iv:authTag:encrypted
 */
export function encryptDebridToken(plainToken: string): string {
	const key = getEncryptionKey();
	const iv = randomBytes(16);
	const cipher = createCipheriv(ALGORITHM, key, iv);

	let encrypted = cipher.update(plainToken, 'utf8', 'hex');
	encrypted += cipher.final('hex');
	const authTag = cipher.getAuthTag();

	// Store as: iv:authTag:encrypted
	return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a debrid API token from encrypted format.
 * Input format: iv:authTag:encrypted
 * Returns null on failure (wrong auth secret, corrupted data).
 */
export function decryptDebridToken(encryptedData: string): string | null {
	try {
		const parts = encryptedData.split(':');
		if (parts.length !== 3) {
			return null;
		}

		const [ivHex, authTagHex, encrypted] = parts;
		const key = getEncryptionKey();

		const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
		decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

		let decrypted = decipher.update(encrypted, 'hex', 'utf8');
		decrypted += decipher.final('utf8');

		return decrypted;
	} catch (error) {
		logger.error(
			{ err: error, component: 'DebridTokenCrypto', logDomain: 'auth' },
			'Failed to decrypt debrid token'
		);
		return null;
	}
}
