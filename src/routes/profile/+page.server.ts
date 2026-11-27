import type { PageServerLoad } from './$types.js';
import { getAdminCount } from '#lib/server/auth/admin-bootstrap.js';
import { hasLocalPassword } from '#lib/server/auth/local-login.js';

export const load: PageServerLoad = async ({ locals }) => {
	const isOnlyAdmin = locals.user?.role === 'admin' ? (await getAdminCount()) <= 1 : false;
	// Plex-sign-in-only accounts have no password to change.
	const hasPassword = locals.user ? await hasLocalPassword(locals.user.id) : true;

	return { isOnlyAdmin, hasPassword };
};
