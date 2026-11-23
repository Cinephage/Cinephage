/**
 * Folders a music scan could not identify.
 *
 * Video's unmatched files are row-shaped: a file, a guessed title, a match
 * action. A music scan refuses at the album-folder level, so its failures need
 * their own small queue. Rows are upserted by folder, which keeps one entry per
 * folder however many times a scan retries it, and "ignore"/"resolved" are
 * statuses rather than deletes so the next scan does not silently resurrect a
 * dismissed path.
 */

import { randomUUID } from 'node:crypto';
import { count, desc, eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { musicScanIssues } from '#lib/server/db/schema.js';

export interface MusicScanIssueRecord {
	id: string;
	folder: string;
	albumTitle: string | null;
	artistName: string | null;
	reason: string;
	status: 'pending' | 'ignored' | 'resolved';
	firstSeenAt: string;
	lastSeenAt: string;
}

export interface MusicScanIssueInput {
	folder: string;
	album: string | null;
	artist: string | null;
	status: 'imported' | 'skipped' | 'unmatched' | 'failed';
	reason?: string;
}

export class MusicScanIssueService {
	/** Upsert this scan's refusals into the review queue. */
	record(rootFolderId: string | null, results: MusicScanIssueInput[]): void {
		const now = new Date().toISOString();

		for (const result of results) {
			if (result.status !== 'unmatched' && result.status !== 'failed') continue;
			const existing = db
				.select({ status: musicScanIssues.status })
				.from(musicScanIssues)
				.where(eq(musicScanIssues.folder, result.folder))
				.get();
			if (existing?.status === 'ignored' || existing?.status === 'resolved') {
				// A dismissal is a decision, not a cache entry. Only the sighting
				// timestamp moves; the same refusal on a later scan does not reopen it.
				db.update(musicScanIssues)
					.set({ lastSeenAt: now })
					.where(eq(musicScanIssues.folder, result.folder))
					.run();
				continue;
			}
			db.insert(musicScanIssues)
				.values({
					id: randomUUID(),
					rootFolderId,
					folder: result.folder,
					albumTitle: result.album,
					artistName: result.artist,
					reason: result.reason ?? result.status,
					status: 'pending',
					firstSeenAt: now,
					lastSeenAt: now
				})
				.onConflictDoUpdate({
					target: musicScanIssues.folder,
					set: {
						albumTitle: result.album,
						artistName: result.artist,
						reason: result.reason ?? result.status,
						status: 'pending',
						resolvedAt: null,
						lastSeenAt: now
					}
				})
				.run();
		}
	}

	listPending(limit = 100): MusicScanIssueRecord[] {
		return db
			.select({
				id: musicScanIssues.id,
				folder: musicScanIssues.folder,
				albumTitle: musicScanIssues.albumTitle,
				artistName: musicScanIssues.artistName,
				reason: musicScanIssues.reason,
				status: musicScanIssues.status,
				firstSeenAt: musicScanIssues.firstSeenAt,
				lastSeenAt: musicScanIssues.lastSeenAt
			})
			.from(musicScanIssues)
			.where(eq(musicScanIssues.status, 'pending'))
			.orderBy(desc(musicScanIssues.lastSeenAt))
			.limit(limit)
			.all();
	}

	countPending(): number {
		const [row] = db
			.select({ count: count() })
			.from(musicScanIssues)
			.where(eq(musicScanIssues.status, 'pending'))
			.all();
		return row?.count ?? 0;
	}

	ignore(id: string): boolean {
		return this.setStatus(id, 'ignored');
	}

	/** A manual import from this folder makes its old scan failure moot. */
	resolveFolder(folder: string): void {
		db.update(musicScanIssues)
			.set({ status: 'resolved', resolvedAt: new Date().toISOString() })
			.where(eq(musicScanIssues.folder, folder))
			.run();
	}

	private setStatus(id: string, status: 'ignored' | 'resolved'): boolean {
		const row = db
			.select({ id: musicScanIssues.id })
			.from(musicScanIssues)
			.where(eq(musicScanIssues.id, id))
			.get();
		if (!row) return false;
		db.update(musicScanIssues)
			.set({ status, resolvedAt: new Date().toISOString() })
			.where(eq(musicScanIssues.id, id))
			.run();
		return true;
	}
}

export const musicScanIssueService = new MusicScanIssueService();
