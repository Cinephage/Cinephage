export {
	auth,
	validateUsername,
	generateDisplayUsername,
	repairCurrentUserAdminRole,
	type AuthSessionUser,
	type AuthSessionRecord
} from './auth.js';
export {
	ensureDefaultApiKeysForUser,
	ensureStreamingApiKeyRateLimit,
	getManagedApiKeysForRequest,
	getOwnerStreamingApiKey,
	getRecoverableApiKeyByType,
	regenerateRecoverableApiKey,
	type RecoverableApiKey,
	type ManagedApiKeyType
} from './api-keys.js';
export {
	HARD_RESERVED_USERNAMES,
	HARD_RESERVED_USERNAMES as RESERVED_USERNAMES,
	isHardReservedUsername,
	isValidUsernameFormat,
	USERNAME_MAX_LENGTH,
	USERNAME_MIN_LENGTH,
	USERNAME_PATTERN
} from '#lib/auth/username-policy.js';
export { isSetupComplete, resetSetupCompleteCache, requireSetup } from './setup.js';
export {
	isAdmin,
	requireAdmin,
	requireAdminPage,
	getUserRole,
	hasPermission,
	isAuthenticated,
	getUser,
	type UserRole
} from './authorization.js';
export {
	ac,
	admin,
	user,
	type UserRole as AccessControlUserRole
} from '#lib/auth/access-control.js';
