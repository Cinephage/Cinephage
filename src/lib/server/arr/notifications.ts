/**
 * Radarr/Sonarr-compatible `notification` (webhook) connections.
 *
 * Third-party arr-compat clients (Pulsarr, Notifiarr, ...) register a
 * webhook here the same way they would on real Radarr/Sonarr, so that
 * Cinephage calls them back on library events. Config is arr-compat
 * specific (it only exists because a client registered it, and only ever
 * carries Radarr/Sonarr-shaped payloads).
 *
 */

import { eq, and } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { arrNotificationConfigs } from '#lib/server/db/schema.js';
import { getOrAssignArrId, getEntityIdForArrId } from './ArrIdMappingService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

type NotificationRow = typeof arrNotificationConfigs.$inferSelect;
type App = 'radarr' | 'sonarr';

interface NotificationField {
	name: string;
	value?: unknown;
}

function fieldValue(fields: unknown, name: string): unknown {
	if (!Array.isArray(fields)) return undefined;
	return (fields as NotificationField[]).find((f) => f?.name === name)?.value;
}

function boolField(body: Record<string, unknown>, key: string): boolean {
	return body[key] === true;
}

async function toResource(row: NotificationRow): Promise<Record<string, unknown>> {
	const arrId = await getOrAssignArrId('notification', row.id);
	return { ...row.config, id: arrId };
}

export async function listNotifications(app: App): Promise<Record<string, unknown>[]> {
	const rows = await db
		.select()
		.from(arrNotificationConfigs)
		.where(eq(arrNotificationConfigs.app, app));
	return Promise.all(rows.map(toResource));
}

export async function getNotificationByArrId(
	app: App,
	arrId: number
): Promise<Record<string, unknown> | null> {
	const id = await getEntityIdForArrId('notification', arrId);
	if (!id) return null;
	const [row] = await db
		.select()
		.from(arrNotificationConfigs)
		.where(and(eq(arrNotificationConfigs.id, id), eq(arrNotificationConfigs.app, app)));
	return row ? toResource(row) : null;
}

export async function createNotification(
	app: App,
	body: Record<string, unknown>
): Promise<Record<string, unknown>> {
	const [row] = await db
		.insert(arrNotificationConfigs)
		.values({
			app,
			name: typeof body.name === 'string' ? body.name : 'Notification',
			onGrab: boolField(body, 'onGrab'),
			onDownload: boolField(body, 'onDownload'),
			onUpgrade: boolField(body, 'onUpgrade'),
			onMovieAdded: boolField(body, 'onMovieAdded'),
			onMovieDelete: boolField(body, 'onMovieDelete'),
			onSeriesAdd: boolField(body, 'onSeriesAdd'),
			onSeriesDelete: boolField(body, 'onSeriesDelete'),
			config: body
		})
		.returning();
	return toResource(row);
}

export async function updateNotificationByArrId(
	app: App,
	arrId: number,
	body: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
	const id = await getEntityIdForArrId('notification', arrId);
	if (!id) return null;
	const [row] = await db
		.update(arrNotificationConfigs)
		.set({
			name: typeof body.name === 'string' ? body.name : 'Notification',
			onGrab: boolField(body, 'onGrab'),
			onDownload: boolField(body, 'onDownload'),
			onUpgrade: boolField(body, 'onUpgrade'),
			onMovieAdded: boolField(body, 'onMovieAdded'),
			onMovieDelete: boolField(body, 'onMovieDelete'),
			onSeriesAdd: boolField(body, 'onSeriesAdd'),
			onSeriesDelete: boolField(body, 'onSeriesDelete'),
			config: body
		})
		.where(and(eq(arrNotificationConfigs.id, id), eq(arrNotificationConfigs.app, app)))
		.returning();
	return row ? toResource(row) : null;
}

export async function deleteNotificationByArrId(app: App, arrId: number): Promise<boolean> {
	const id = await getEntityIdForArrId('notification', arrId);
	if (!id) return false;
	const result = await db
		.delete(arrNotificationConfigs)
		.where(and(eq(arrNotificationConfigs.id, id), eq(arrNotificationConfigs.app, app)));
	return result.changes > 0;
}

/**
 * Sends one webhook payload to one registered connection. Real Radarr's
 * "Webhook" implementation fields: url (string), method (1=POST, 2=PUT),
 * username/password (optional basic auth), headers (optional
 * keyValueList of {key, value}). Never throws - a broken third-party
 * webhook must never fail the import it's reporting on.
 */
async function sendWebhook(row: NotificationRow, payload: Record<string, unknown>): Promise<void> {
	const fields = (row.config as { fields?: unknown })?.fields;
	const url = fieldValue(fields, 'url');
	if (typeof url !== 'string' || !url) return;

	const method = fieldValue(fields, 'method') === 2 ? 'PUT' : 'POST';
	const username = fieldValue(fields, 'username');
	const password = fieldValue(fields, 'password');
	const headerList = fieldValue(fields, 'headers');

	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (Array.isArray(headerList)) {
		for (const entry of headerList as Array<{ key?: unknown; value?: unknown }>) {
			if (typeof entry?.key === 'string' && typeof entry?.value === 'string') {
				headers[entry.key] = entry.value;
			}
		}
	}
	if (typeof username === 'string' && username) {
		headers['authorization'] =
			`Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`;
	}

	try {
		const response = await fetch(url, { method, headers, body: JSON.stringify(payload) });
		if (!response.ok) {
			logger.warn(
				{ notificationId: row.id, name: row.name, status: response.status },
				'[arr-compat] Notification webhook returned a non-OK response'
			);
		}
	} catch (err) {
		logger.warn(
			{
				notificationId: row.id,
				name: row.name,
				err: err instanceof Error ? err.message : String(err)
			},
			'[arr-compat] Failed to call notification webhook'
		);
	}
}

async function connectionsFor(app: App, flag: keyof NotificationRow): Promise<NotificationRow[]> {
	return db
		.select()
		.from(arrNotificationConfigs)
		.where(and(eq(arrNotificationConfigs.app, app), eq(arrNotificationConfigs[flag], true)));
}

/** Fires the "Download" (import complete) event for a movie. */
export async function notifyMovieDownload(movie: { title: string; tmdbId: number }): Promise<void> {
	const rows = await connectionsFor('radarr', 'onDownload');
	if (rows.length === 0) return;

	const payload = {
		eventType: 'Download',
		instanceName: 'Cinephage',
		movie: { title: movie.title, tmdbId: movie.tmdbId, tags: [] as string[] }
	};
	await Promise.all(rows.map((row) => sendWebhook(row, payload)));
}

/** Fires the "Download" (import complete) event for one episode file. */
export async function notifySeriesDownload(
	series: { title: string; tvdbId: number | null },
	episodes: Array<{
		episodeNumber: number;
		seasonNumber: number;
		title: string | null;
		overview: string | null;
		airDate: string | null;
	}>,
	episodeFile: { id: number; relativePath: string; quality: string; size: number }
): Promise<void> {
	if (!series.tvdbId) return; // Sonarr's schema requires a real tvdbId - nothing to send without one.
	const rows = await connectionsFor('sonarr', 'onDownload');
	if (rows.length === 0) return;

	const payload = {
		eventType: 'Download',
		instanceName: 'Cinephage',
		series: { title: series.title, tvdbId: series.tvdbId, tags: [] as string[] },
		episodes: episodes.map((ep) => ({
			episodeNumber: ep.episodeNumber,
			seasonNumber: ep.seasonNumber,
			title: ep.title ?? '',
			overview: ep.overview ?? '',
			airDateUtc: ep.airDate ?? new Date().toISOString()
		})),
		episodeFile: {
			id: episodeFile.id,
			relativePath: episodeFile.relativePath,
			quality: episodeFile.quality,
			qualityVersion: 1,
			size: episodeFile.size
		}
	};
	await Promise.all(rows.map((row) => sendWebhook(row, payload)));
}
