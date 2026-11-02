import { PLACEHOLDER_PACKAGE_VERSION } from '#lib/version.js';

function readVersion(value: string | undefined | null): string | null {
	const normalized = value?.trim();
	if (!normalized) return null;
	if (normalized === PLACEHOLDER_PACKAGE_VERSION) return null;
	return normalized;
}

export function resolveAppVersion(): string {
	return (
		readVersion(process.env.APP_VERSION) ??
		readVersion(process.env.npm_package_version) ??
		'dev-local'
	);
}
