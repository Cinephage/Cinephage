import type { PageServerLoad } from './$types.js';
import { getAdminCount } from '#lib/server/auth/admin-bootstrap.js';

export const load: PageServerLoad = async ({ locals }) => {
	const isOnlyAdmin = locals.user?.role === 'admin' ? (await getAdminCount()) <= 1 : false;

	return { isOnlyAdmin };
};
