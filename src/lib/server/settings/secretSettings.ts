import {
	decryptRecordSecrets,
	encryptRecordSecrets,
	findSecretFieldSpec
} from '#lib/server/crypto/secretFields.js';

/**
 * Encrypt/decrypt settings-table values whose rows hold third-party secrets
 * (metadata API keys, Jackett/Prowlarr connection blobs) and captcha-solver
 * proxy credentials. Non-secret keys pass through untouched. JSON blobs are
 * walked per-key; scalar values are enveloped whole.
 */

const SETTINGS_SPEC = findSecretFieldSpec('settings')!;
const CAPTCHA_SPEC = findSecretFieldSpec('captcha_solver_settings')!;

export function encryptSettingValue(key: string, value: string): string {
	const row = { key, value };
	encryptRecordSecrets(SETTINGS_SPEC, row);
	return row.value ?? value;
}

export function decryptSettingValue(key: string, value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const row = { key, value };
	decryptRecordSecrets(SETTINGS_SPEC, row);
	return row.value ?? null;
}

export function encryptCaptchaSettingValue(key: string, value: string): string {
	const row = { key, value };
	encryptRecordSecrets(CAPTCHA_SPEC, row);
	return row.value ?? value;
}

export function decryptCaptchaSettingValue(
	key: string,
	value: string | null | undefined
): string | null {
	if (value === null || value === undefined) return null;
	const row = { key, value };
	decryptRecordSecrets(CAPTCHA_SPEC, row);
	return row.value ?? null;
}
