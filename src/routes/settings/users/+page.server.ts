import type { PageServerLoad } from './$types';
import { asc, count, eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { session, user, userMediaServerLinks } from '#lib/server/db/schema.js';
import { requireAdminPage } from '#lib/server/auth/authorization.js';

export const load: PageServerLoad = async ({ locals }) => {
	requireAdminPage(locals);

	const users = await db
		.select({
			id: user.id,
			username: user.username,
			displayUsername: user.displayUsername,
			email: user.email,
			role: user.role,
			banned: user.banned,
			banReason: user.banReason,
			banExpires: user.banExpires,
			createdAt: user.createdAt,
			image: user.image,
			mediaServerId: userMediaServerLinks.serverId
		})
		.from(user)
		.leftJoin(userMediaServerLinks, eq(userMediaServerLinks.userId, user.id))
		.orderBy(asc(user.createdAt));

	const sessionCounts = await db
		.select({ userId: session.userId, value: count() })
		.from(session)
		.groupBy(session.userId);
	const sessionCountByUser = new Map(sessionCounts.map((row) => [row.userId, row.value]));

	return {
		users: users.map((row) => ({
			...row,
			sessionCount: sessionCountByUser.get(row.id) ?? 0
		}))
	};
};
