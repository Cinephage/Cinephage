export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
// Extending username to allow periods or hyphens
export const USERNAME_PATTERN = /^[a-zA-Z0-9_]+(?:[.-][a-zA-Z0-9_]+)*$/;

/**
 * Hard-reserved usernames map to real app namespaces, auth endpoints,
 * or obvious system identities.
 */
export const HARD_RESERVED_USERNAMES = [
	'api',
	'auth',
	'login',
	'logout',
	'signin',
	'signout',
	'signup',
	'register',
	'root',
	'setup',
	'system',
	'profile',
	'user'
] as const;

function normalizeUsername(username: string): string {
	return username.trim().toLowerCase();
}

export function isValidUsernameFormat(username: string): boolean {
	return (
		username.length >= USERNAME_MIN_LENGTH &&
		username.length <= USERNAME_MAX_LENGTH &&
		USERNAME_PATTERN.test(username)
	);
}

export function isHardReservedUsername(username: string): boolean {
	return HARD_RESERVED_USERNAMES.includes(
		normalizeUsername(username) as (typeof HARD_RESERVED_USERNAMES)[number]
	);
}
