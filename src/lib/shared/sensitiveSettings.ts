const SENSITIVE_KEY_PATTERNS = ['key', 'password', 'secret', 'token', 'cookie', 'passkey'];
const REDACTED_VALUE = '[REDACTED]';

export { REDACTED_VALUE };

export interface SensitiveSettingLike {
	name: string;
	type: string;
}

export function isSensitiveKeyName(name: string): boolean {
	const lowerName = name.toLowerCase();
	return SENSITIVE_KEY_PATTERNS.some((pattern) => lowerName.includes(pattern));
}

export function isSensitiveSettingName(name: string, type?: string): boolean {
	return type === 'password' || isSensitiveKeyName(name);
}

export function isSensitiveDefinitionSetting(setting: SensitiveSettingLike): boolean {
	return isSensitiveSettingName(setting.name, setting.type);
}

export function isBlankOrRedacted(value: unknown): boolean {
	return value === '' || value === null || value === undefined || value === REDACTED_VALUE;
}
