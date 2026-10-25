import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async ({ locals }) => {
	// Anonymous page requests never reach here (hooks redirect to /login);
	// this just carries the role through for the page's mode switch.
	return {
		role: locals.user?.role ?? 'user'
	};
};
