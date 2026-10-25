import type Database from 'better-sqlite3';
import { count, eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { user } from '#lib/server/db/schema.js';

function tableExists(sqlite: Database.Database, tableName: string): boolean {
	return !!sqlite
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
		.get(tableName);
}

function columnExists(sqlite: Database.Database, tableName: string, columnName: string): boolean {
	return (
		sqlite.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
			name: string;
		}>
	).some((column) => column.name === columnName);
}

/**
 * In Cinephage's single-user bootstrap flow, the sole account must be admin.
 * This repairs older installs where the first account was mistakenly created as "user".
 */
export function ensureSoleUserIsAdmin(sqlite: Database.Database, expectedUserId?: string): boolean {
	if (!tableExists(sqlite, 'user') || !columnExists(sqlite, 'user', 'role')) {
		return false;
	}

	const users = sqlite
		.prepare(`SELECT "id", "role" FROM "user" ORDER BY "createdAt" ASC LIMIT 2`)
		.all() as Array<{ id: string; role: string | null }>;

	if (users.length !== 1) {
		return false;
	}

	const [user] = users;
	if (expectedUserId && user.id !== expectedUserId) {
		return false;
	}

	if (user.role === 'admin') {
		return true;
	}

	if (columnExists(sqlite, 'user', 'updatedAt')) {
		sqlite
			.prepare(`UPDATE "user" SET "role" = 'admin', "updatedAt" = ? WHERE "id" = ?`)
			.run(new Date().toISOString(), user.id);
	} else {
		sqlite.prepare(`UPDATE "user" SET "role" = 'admin' WHERE "id" = ?`).run(user.id);
	}

	return true;
}

/**
 * Runtime-safe variant that uses the shared app database abstraction.
 * Keep this as the default path for request handling; raw SQLite access remains
 * available above for schema repair and operational compatibility code.
 */
export async function ensureSoleUserIsAdminRecord(expectedUserId?: string): Promise<boolean> {
	const [{ value: userCount }] = await db.select({ value: count() }).from(user);

	if (userCount !== 1) {
		return false;
	}

	const existingUser = await db.query.user.findFirst({
		columns: {
			id: true,
			role: true
		}
	});

	if (!existingUser) {
		return false;
	}

	if (expectedUserId && existingUser.id !== expectedUserId) {
		return false;
	}

	if (existingUser.role === 'admin') {
		return true;
	}

	await db
		.update(user)
		.set({
			role: 'admin',
			updatedAt: new Date().toISOString()
		})
		.where(eq(user.id, existingUser.id));

	return true;
}

/**
 * Admin account count. The last-admin guards (demotion, deletion) key off
 * this: an instance must always keep at least one admin regardless of how
 * many viewer accounts exist.
 */
export async function getAdminCount(): Promise<number> {
	const [{ value: adminCount }] = await db
		.select({ value: count() })
		.from(user)
		.where(eq(user.role, 'admin'));
	return adminCount;
}

/**
 * A user's current role, or null when the id does not exist.
 */
export async function getUserRoleById(userId: string): Promise<string | null> {
	const existing = await db.query.user.findFirst({
		where: eq(user.id, userId),
		columns: { role: true }
	});
	return existing?.role ?? null;
}
