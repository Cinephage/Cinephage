/**
 * Authorization helpers for RBAC
 *
 * Provides utility functions for checking admin status and permissions.
 * Multi-user: accounts hold role 'admin' or 'user'; viewer accounts are
 * additionally constrained by the non-admin API allowlist in hooks.server.ts.
 */
import { error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';

/**
 * User role type
 */
export type UserRole = 'admin' | 'user';

/**
 * Check if the current user is an admin
 */
export function isAdmin(event: RequestEvent): boolean {
	return event.locals.user?.role === 'admin';
}

/**
 * Require admin access in page/layout server loads.
 * Throws a 403 SvelteKit error for unauthenticated or non-admin visitors;
 * the hooks chain guarantees locals.user exists by the time loads run.
 *
 * Usage in +page.server.ts / +layout.server.ts:
 * ```typescript
 * export const load: PageServerLoad = async ({ locals }) => {
 *   requireAdminPage(locals);
 *   // ... load data
 * };
 * ```
 */
export function requireAdminPage(locals: App.Locals): void {
	if (locals.user?.role !== 'admin') {
		throw error(403, 'Admin access required');
	}
}

/**
 * Require admin access for API routes
 * Returns 403 response if user is not an admin
 *
 * Usage in +server.ts:
 * ```typescript
 * export const POST: RequestHandler = async (event) => {
 *   const authError = requireAdmin(event);
 *   if (authError) return authError;
 *   // ... handle request
 * };
 * ```
 */
export function requireAdmin(event: RequestEvent): Response | null {
	return requireAdminLocals(event.locals);
}

/**
 * Same check as requireAdmin for handlers that destructure their arguments
 * (`async ({ params, locals }) =>`). The hooks viewer gate already confines
 * these routes; this is defense-in-depth so a future gate refactor cannot
 * silently expose them.
 */
export function requireAdminLocals(locals: App.Locals): Response | null {
	if (!locals.user) {
		return Response.json(
			{
				success: false,
				error: 'Unauthorized. Authentication required.',
				code: 'UNAUTHORIZED'
			},
			{ status: 401 }
		);
	}

	if (locals.user.role !== 'admin') {
		return Response.json(
			{
				success: false,
				error: 'Forbidden. Admin access required.',
				code: 'FORBIDDEN'
			},
			{ status: 403 }
		);
	}

	return null;
}

/**
 * Require authentication for API routes
 * Returns 401 response if user is not authenticated
 *
 * Usage in +server.ts:
 * ```typescript
 * export const GET: RequestHandler = async (event) => {
 *   const authError = requireAuth(event);
 *   if (authError) return authError;
 *   // ... handle request
 * };
 * ```
 */
export function requireAuth(event: RequestEvent): Response | null {
	if (!event.locals.user) {
		return Response.json(
			{
				success: false,
				error: 'Unauthorized. Authentication required.',
				code: 'UNAUTHORIZED'
			},
			{ status: 401 }
		);
	}
	return null;
}

/**
 * Get current user role from event locals
 */
export function getUserRole(event: RequestEvent): UserRole | null {
	return (event.locals.user?.role as UserRole) || null;
}

/**
 * Permission set type
 */
type PermissionSet = Record<string, string[]>;

/**
 * Check if user has a specific permission
 *
 * @param permissions - The permission set to check
 * @param resource - The resource (e.g., 'indexer', 'library')
 * @param action - The action (e.g., 'create', 'read', 'update', 'delete')
 * @returns boolean indicating if permission is granted
 */
export function hasPermission(
	permissions: PermissionSet | null | undefined,
	resource: string,
	action: string
): boolean {
	if (!permissions) {
		return false;
	}

	// Check wildcard permission
	if (permissions['*']?.includes('*')) {
		return true;
	}

	// Check resource-specific wildcard
	const resourcePerms = permissions[resource];
	if (!resourcePerms) {
		return false;
	}

	if (resourcePerms.includes('*')) {
		return true;
	}

	return resourcePerms.includes(action);
}

/**
 * Type guard to check if user is authenticated
 */
export function isAuthenticated(event: RequestEvent): boolean {
	return !!event.locals.user;
}

/**
 * Get current user from event locals
 * Throws error if user is not authenticated (for use after requireAuth check)
 */
export function getUser(event: RequestEvent) {
	if (!event.locals.user) {
		throw new Error('User not authenticated');
	}
	return event.locals.user;
}
