import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { logger } from '#lib/logging/index.js';
import { getAuthSecret } from '../auth/secret.js';

const ALGORITHM = 'aes-256-gcm';

/**
 * Derive encryption key from Better Auth secret
 */
function getEncryptionKey(): Buffer {
	const secret = getAuthSecret();
	return scryptSync(secret, 'cinephage-api-key-v1', 32);
}

/**
 * Encrypt an API key using AES-256-GCM
 * Returns string in format: iv:authTag:encrypted
 */
export function encryptApiKey(plainKey: string): string {
	const key = getEncryptionKey();
	const iv = randomBytes(16);
	const cipher = createCipheriv(ALGORITHM, key, iv);

	let encrypted = cipher.update(plainKey, 'utf8', 'hex');
	encrypted += cipher.final('hex');
	const authTag = cipher.getAuthTag();

	// Store as: iv:authTag:encrypted
	return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt an API key from encrypted format
 * Input format: iv:authTag:encrypted
 */
export function decryptApiKey(encryptedData: string): string | null {
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
			{ err: error, component: 'ApiKeyCrypto', logDomain: 'auth' },
			'Failed to decrypt API key'
		);
		return null;
	}
}
