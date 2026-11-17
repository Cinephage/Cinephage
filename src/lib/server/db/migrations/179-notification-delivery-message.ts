import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 179: the delivery log keeps the rendered message.
 *
 * A failed attempt had no way back: the payload was never stored, so "retry"
 * could only ever mean "send a test". The rendered message is a small,
 * bounded JSON document (title/body/fields/link/image) and storing it gives
 * exact retries plus a log the admin can read instead of guessing.
 *
 * Idempotent: `ALTER TABLE ... ADD COLUMN` is guarded by a column check
 * because a fresh database replays every migration over the DDL.
 */
export const migration_v179: MigrationDefinition = {
	version: 179,
	name: 'notification_delivery_message',
	apply: (sqlite) => {
		const columns = sqlite.prepare(`PRAGMA table_info("notification_deliveries")`).all() as Array<{
			name: string;
		}>;
		if (!columns.some((column) => column.name === 'message')) {
			sqlite.prepare(`ALTER TABLE "notification_deliveries" ADD COLUMN "message" text`).run();
		}
	}
};
