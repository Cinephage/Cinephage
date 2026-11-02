import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Version 141: Subtitle reconciliation / backoff / upgrade rotation (Phase 3 Task 1).
 *
 * - Adds subtitles.last_checked_at so the upgrade task can rotate fairly (order by
 *   last_checked_at ASC, stamping each examined row).
 * - Creates subtitle_search_state: per-requirement adaptive backoff keyed by
 *   (owner_type, owner_id, requirement_key). One failing requirement no longer
 *   gates every other requirement for the same media item. The old per-item
 *   movies/episodes.failed_subtitle_attempts and first_subtitle_search_at columns
 *   are deprecated in place (kept for Phase 7 cleanup).
 * - Rewrites episode subtitle relative paths from the series-folder base (incl. the
 *   season directory) into the episode-dir base used by download/delete/sync:
 *   `Season 01/Ep.en.srt` -> `Ep.en.srt`. Rows are only touched when the owning
 *   episode file can be resolved through episode_files.episode_ids, so the rewrite
 *   is idempotent and safe to re-run.
 */

const BATCH_SIZE = 500;

const SUBTITLE_SEARCH_STATE_DDL = `
	CREATE TABLE IF NOT EXISTS "subtitle_search_state" (
		"owner_type" text NOT NULL,
		"owner_id" text NOT NULL,
		"requirement_key" text NOT NULL,
		"failed_attempts" integer NOT NULL DEFAULT 0,
		"first_search_at" text,
		"last_search_at" text,
		PRIMARY KEY ("owner_type", "owner_id", "requirement_key")
	)`;

const SUBTITLE_SEARCH_STATE_OWNER_INDEX = `
	CREATE INDEX IF NOT EXISTS "idx_subtitle_search_state_owner" ON "subtitle_search_state" ("owner_type", "owner_id")`;

/** Treat both separators as path separators when comparing stored relative paths. */
function normalizeSeparators(value: string): string {
	return value.replace(/\\/g, '/');
}

function dirnameOf(value: string): string {
	const normalized = normalizeSeparators(value);
	const index = normalized.lastIndexOf('/');
	return index === -1 ? '' : normalized.slice(0, index);
}

/**
 * Map every episode id to the distinct directories of the episode_files that own
 * it. `episode_files.episode_ids` is a JSON array (a single file can serve several
 * episodes, e.g. double episodes).
 */
function buildEpisodeFileDirs(sqlite: Database.Database): Map<string, string[]> {
	const dirsByEpisode = new Map<string, string[]>();
	if (
		!tableExists(sqlite, 'episode_files') ||
		!columnExists(sqlite, 'episode_files', 'episode_ids') ||
		!columnExists(sqlite, 'episode_files', 'relative_path')
	) {
		return dirsByEpisode;
	}

	const rows = sqlite
		.prepare(
			`SELECT episode_ids, relative_path FROM episode_files
			 WHERE episode_ids IS NOT NULL AND relative_path IS NOT NULL`
		)
		.all() as Array<{ episode_ids: string; relative_path: string }>;

	for (const row of rows) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.episode_ids);
		} catch {
			continue; // Malformed JSON: leave those episodes unresolvable.
		}
		if (!Array.isArray(parsed)) continue;

		const dir = dirnameOf(row.relative_path);
		for (const episodeId of parsed) {
			if (typeof episodeId !== 'string' || episodeId === '') continue;
			const existing = dirsByEpisode.get(episodeId);
			if (!existing) {
				dirsByEpisode.set(episodeId, [dir]);
			} else if (!existing.includes(dir)) {
				existing.push(dir);
			}
		}
	}

	return dirsByEpisode;
}

/**
 * Rewrite episode subtitle rows that still carry the series-folder/season prefix
 * into the episode-dir base. Rows already in the target base are left untouched
 * (the prefix cannot match a bare filename), which makes a second apply a no-op.
 */
function rewriteEpisodeSubtitlePaths(sqlite: Database.Database): {
	rewritten: number;
	skipped: number;
} {
	if (
		!tableExists(sqlite, 'subtitles') ||
		!columnExists(sqlite, 'subtitles', 'episode_id') ||
		!columnExists(sqlite, 'subtitles', 'relative_path')
	) {
		return { rewritten: 0, skipped: 0 };
	}

	const dirsByEpisode = buildEpisodeFileDirs(sqlite);
	const rows = sqlite
		.prepare(`SELECT id, episode_id, relative_path FROM subtitles WHERE episode_id IS NOT NULL`)
		.all() as Array<{ id: string; episode_id: string; relative_path: string }>;

	const pending: Array<{ id: string; relativePath: string }> = [];
	let skipped = 0;

	for (const row of rows) {
		const dirs = dirsByEpisode.get(row.episode_id);
		if (!dirs) {
			// No episode_files row owns this episode: cannot determine a target base.
			skipped += 1;
			continue;
		}

		const normalized = normalizeSeparators(row.relative_path);
		// Prefer the longest matching directory prefix (handles nested episode dirs).
		let matchedDir: string | null = null;
		for (const dir of dirs) {
			if (dir === '') continue;
			const prefix = dir.endsWith('/') ? dir : `${dir}/`;
			if (
				normalized.startsWith(prefix) &&
				(matchedDir === null || dir.length > matchedDir.length)
			) {
				matchedDir = dir;
			}
		}
		if (matchedDir === null) continue; // Already episode-dir-relative.

		pending.push({ id: row.id, relativePath: normalized.slice(matchedDir.length + 1) });
	}

	if (pending.length > 0) {
		const update = sqlite.prepare(`UPDATE subtitles SET relative_path = ? WHERE id = ?`);
		for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
			const chunk = pending.slice(offset, offset + BATCH_SIZE);
			sqlite.transaction(() => {
				for (const change of chunk) update.run(change.relativePath, change.id);
			})();
		}
	}

	return { rewritten: pending.length, skipped };
}

export const migration_v141: MigrationDefinition = {
	version: 141,
	name: 'subtitle_search_state_and_episode_path_base',
	apply: (sqlite: Database.Database) => {
		// 1. Upgrade rotation column on subtitles.
		if (tableExists(sqlite, 'subtitles') && !columnExists(sqlite, 'subtitles', 'last_checked_at')) {
			sqlite.prepare(`ALTER TABLE "subtitles" ADD COLUMN "last_checked_at" text`).run();
			logger.info('[migration v141] Added subtitles.last_checked_at');
		}

		// 2. Per-requirement adaptive backoff table + owner lookup index.
		sqlite.exec(SUBTITLE_SEARCH_STATE_DDL);
		sqlite.exec(SUBTITLE_SEARCH_STATE_OWNER_INDEX);

		// 3. Move episode subtitle rows onto the episode-dir path base.
		const { rewritten, skipped } = rewriteEpisodeSubtitlePaths(sqlite);
		logger.info(
			{ rewritten, skipped },
			'[migration v141] Rewrote episode subtitle relative paths to the episode-dir base'
		);

		// 4. Integrity gates (report, never fail the migration).
		const fkViolations = sqlite.prepare('PRAGMA foreign_key_check').all();
		if (fkViolations.length > 0) {
			logger.warn(
				{ count: fkViolations.length, sample: fkViolations.slice(0, 10) },
				'[migration v141] foreign_key_check reported violations'
			);
		}
		const quickCheck = sqlite.prepare('PRAGMA quick_check').pluck().get() as string | undefined;
		if (quickCheck !== 'ok') {
			logger.warn({ quickCheck }, '[migration v141] quick_check reported problems');
		}
	}
};
