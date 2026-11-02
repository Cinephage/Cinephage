import { resolveAppVersion } from '#lib/server/version.js';

export function load() {
	return { version: resolveAppVersion() };
}
