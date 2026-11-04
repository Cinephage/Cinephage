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

/**
 * Short git commit the image was built from (VCS_REF build arg -> APP_COMMIT
 * env in the Docker runtime stage). Unknown for non-container dev runs.
 */
export function resolveAppCommit(): string {
	return readVersion(process.env.APP_COMMIT) ?? 'unknown';
}
