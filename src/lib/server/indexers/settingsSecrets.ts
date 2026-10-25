import {
	isBlankOrRedacted,
	isSensitiveDefinitionSetting,
	isSensitiveKeyName,
	isSensitiveSettingName
} from '#lib/shared/sensitiveSettings.js';

interface SensitiveSettingDefinition {
	name: string;
	type: string;
}

function isSensitiveKey(key: string): boolean {
	return isSensitiveKeyName(key);
}

function isSensitiveSetting(
	key: string,
	definitions?: SensitiveSettingDefinition[] | null
): boolean {
	const definition = definitions?.find((setting) => setting.name === key);
	return definition ? isSensitiveDefinitionSetting(definition) : isSensitiveSettingName(key);
}

export function redactIndexerSettingsForForm(
	settings: Record<string, unknown> | null | undefined,
	definitions?: SensitiveSettingDefinition[] | null
): Record<string, string> | null {
	if (!settings) return null;

	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(settings)) {
		if (value === undefined || value === null) continue;
		result[key] = isSensitiveSetting(key, definitions) ? '' : String(value);
	}

	return Object.keys(result).length > 0 ? result : null;
}

export function getSensitiveIndexerSettingsPresence(
	settings: Record<string, unknown> | null | undefined,
	definitions?: SensitiveSettingDefinition[] | null
): Record<string, boolean> {
	const result: Record<string, boolean> = {};

	for (const definition of definitions ?? []) {
		if (!isSensitiveSetting(definition.name, definitions)) continue;
		const value = settings?.[definition.name];
		result[definition.name] = value !== undefined && value !== null && value !== '';
	}

	if (settings) {
		for (const [key, value] of Object.entries(settings)) {
			if (!isSensitiveKey(key)) continue;
			result[key] = value !== undefined && value !== null && value !== '';
		}
	}

	return result;
}

export function mergeBlankSensitiveIndexerSettings(
	incoming: Record<string, unknown> | null | undefined,
	existing: Record<string, unknown> | null | undefined,
	definitions?: SensitiveSettingDefinition[] | null
): Record<string, string> {
	const merged: Record<string, string> = {};

	if (existing) {
		for (const [key, value] of Object.entries(existing)) {
			if (value !== undefined && value !== null) {
				merged[key] = String(value);
			}
		}
	}

	for (const [key, value] of Object.entries(incoming ?? {})) {
		if (isSensitiveSetting(key, definitions) && isBlankOrRedacted(value)) {
			continue;
		}
		if (value !== undefined && value !== null) {
			merged[key] = String(value);
		}
	}

	return merged;
}
