/**
 * Access Control Configuration
 *
 * Defines roles and permissions for RBAC using Better Auth's access control system.
 *
 * IMPORTANT: This file is SHARED between client and server.
 * Do NOT import server-only modules here.
 * This is client-safe code - only imports from better-auth/plugins/access.
 */
import { createAccessControl } from 'better-auth/plugins/access';

/**
 * Resource permissions available in Cinephage
 */
const statements = {
	// User management — the verbs the Better Auth admin plugin actually
	// checks (createUser/listUsers/setRole/ban/impersonate/...).
	user: [
		'create',
		'delete',
		'get',
		'list',
		'update',
		'ban',
		'impersonate',
		'impersonate-admins',
		'set-email',
		'set-password',
		'set-role'
	],

	// Session management (admin plugin list/revoke session endpoints)
	session: ['list', 'revoke'],

	// Indexer management
	indexer: ['create', 'read', 'update', 'delete'],

	// Download client management
	downloadClient: ['create', 'read', 'update', 'delete'],

	// Root folder management
	rootFolder: ['create', 'read', 'update', 'delete'],

	// System settings
	settings: ['create', 'read', 'update', 'delete'],

	// Library management (admin operations)
	library: ['create', 'read', 'update', 'delete', 'scan', 'import'],

	// Task execution
	task: ['create', 'read', 'update', 'delete', 'execute'],

	// Quality profile management
	qualityProfile: ['create', 'read', 'update', 'delete'],

	// Scoring profile management
	scoringProfile: ['create', 'read', 'update', 'delete'],

	// Custom format management
	customFormat: ['create', 'read', 'update', 'delete'],

	// Naming convention management
	naming: ['create', 'read', 'update', 'delete'],

	// NNTP/Usenet server management
	nntpServer: ['create', 'read', 'update', 'delete'],

	// Captcha solver settings
	captcha: ['create', 'read', 'update', 'delete'],

	// Smart list management
	smartList: ['create', 'read', 'update', 'delete'],

	// Notification settings
	notification: ['create', 'read', 'update', 'delete'],

	// Monitoring configuration
	monitoring: ['create', 'read', 'update', 'delete']
} as const;

/**
 * Access controller instance
 */
export const ac = createAccessControl(statements);

/**
 * Admin role - full access to everything, including user management
 */
export const admin = ac.newRole({
	user: [
		'create',
		'delete',
		'get',
		'list',
		'update',
		'ban',
		'impersonate',
		'impersonate-admins',
		'set-email',
		'set-password',
		'set-role'
	],
	session: ['list', 'revoke'],
	indexer: ['create', 'read', 'update', 'delete'],
	downloadClient: ['create', 'read', 'update', 'delete'],
	rootFolder: ['create', 'read', 'update', 'delete'],
	settings: ['create', 'read', 'update', 'delete'],
	library: ['create', 'read', 'update', 'delete', 'scan', 'import'],
	task: ['create', 'read', 'update', 'delete', 'execute'],
	qualityProfile: ['create', 'read', 'update', 'delete'],
	scoringProfile: ['create', 'read', 'update', 'delete'],
	customFormat: ['create', 'read', 'update', 'delete'],
	naming: ['create', 'read', 'update', 'delete'],
	nntpServer: ['create', 'read', 'update', 'delete'],
	captcha: ['create', 'read', 'update', 'delete'],
	smartList: ['create', 'read', 'update', 'delete'],
	notification: ['create', 'read', 'update', 'delete'],
	monitoring: ['create', 'read', 'update', 'delete']
});

/**
 * User role - limited access for future multi-user support
 * Currently not used (single admin only), but defined for future expansion
 */
export const user = ac.newRole({
	library: ['read'],
	settings: ['read']
});

/**
 * Type for user roles
 */
export type UserRole = 'admin' | 'user';
