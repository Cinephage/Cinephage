import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';
import { normalizeLanguageTag } from '../../languages/normalize.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Version 140: Media-server stats language normalization (Phase 5 Task 2).
 *
 * On media_server_synced_items:
 * - Adds audio_languages_raw / subtitle_languages_raw (nullable text JSON
 *   arrays) holding the language strings EXACTLY as the media server reported
 *   them, so provenance survives ingestion-time normalization.
 * - Canonicalizes the existing audio_languages / subtitle_languages arrays in
 *   place via normalizeLanguageTag: entries are canonicalized, duplicates
 *   collapse onto their first occurrence, order is kept, and both empty values
 *   and unknown (`und`) results are dropped from the canonical arrays. Unknown
 *   non-empty raw values survive only in the new raw columns. The originals
 *   are copied into the raw columns BEFORE the canonical arrays are
 *   overwritten; rows whose raw column is already set are skipped, which makes
 *   a second apply a no-op.
 * - Rows whose stored value is not parseable JSON (or not an array) are left
 *   untouched and logged.
 *
 * STRUCTURE NOTE (Phase 5 Task 3, applied): this migration also adds the
 * epg_programs i18n columns — title_i18n / description_i18n / category_i18n
 * (nullable text JSON arrays of { lang: string | null, text: string }). They
 * preserve every XMLTV text element variant with its lower-cased `@_lang`
 * attribute so text selection can happen at display time. Existing rows keep
 * NULL i18n columns; readers fall back to the plain title/description/category
 * columns. apply() is an ordered list of named steps, each individually
 * idempotent, finished by the integrity gates.
 */

const BATCH_SIZE = 500;

/** (canonical column, raw provenance column) pairs on media_server_synced_items. */
const SYNCED_ITEM_LANGUAGE_COLUMNS = [
	{ canonical: 'audio_languages', raw: 'audio_languages_raw' },
	{ canonical: 'subtitle_languages', raw: 'subtitle_languages_raw' }
] as const;

/**
 * epg_programs columns holding ALL localized XMLTV text variants as JSON
 * arrays of { lang: string | null, text: string } (Phase 5 Task 3).
 */
const EPG_PROGRAM_I18N_COLUMNS = ['title_i18n', 'description_i18n', 'category_i18n'] as const;

/** Step 1 — add the raw provenance columns (no-op when they already exist). */
function addSyncedItemRawLanguageColumns(sqlite: Database.Database): void {
	if (!tableExists(sqlite, 'media_server_synced_items')) return;
	for (const { raw } of SYNCED_ITEM_LANGUAGE_COLUMNS) {
		if (columnExists(sqlite, 'media_server_synced_items', raw)) continue;
		sqlite.prepare(`ALTER TABLE "media_server_synced_items" ADD COLUMN "${raw}" text`).run();
		logger.info(`[migration v140] Added media_server_synced_items.${raw}`);
	}
}

export interface SplitLanguageArray {
	/** Untouched source strings, first-seen order, deduped, empties dropped. */
	raw: string[];
	/** Canonical tags, first-seen order, deduped; empty and `und` dropped. */
	canonical: string[];
}

/**
 * Split a stored language array into the raw + canonical views using the same
 * ingestion rules as the media-server stats providers (language-normalize.ts):
 * non-string and empty entries are dropped, raw strings are deduped verbatim,
 * canonical tags dedupe onto their first occurrence, and unknown (`und`)
 * results are dropped from the canonical view.
 */
export function splitRawAndCanonical(value: unknown): SplitLanguageArray | null {
	if (!Array.isArray(value)) return null;

	const raw: string[] = [];
	const canonical: string[] = [];
	const seenRaw = new Set<string>();
	const seenCanonical = new Set<string>();

	for (const entry of value) {
		if (typeof entry !== 'string') continue;
		if (entry.trim() === '') continue;

		if (!seenRaw.has(entry)) {
			seenRaw.add(entry);
			raw.push(entry);
		}

		const tag = normalizeLanguageTag(entry);
		if (tag === 'und' || seenCanonical.has(tag)) continue;
		seenCanonical.add(tag);
		canonical.push(tag);
	}

	return { raw, canonical };
}

/** Step 2 — canonicalize stored language arrays, preserving originals in the raw columns. */
function canonicalizeSyncedItemLanguages(sqlite: Database.Database): void {
	if (!tableExists(sqlite, 'media_server_synced_items')) return;

	for (const { canonical: canonicalColumn, raw: rawColumn } of SYNCED_ITEM_LANGUAGE_COLUMNS) {
		if (!columnExists(sqlite, 'media_server_synced_items', canonicalColumn)) continue;
		if (!columnExists(sqlite, 'media_server_synced_items', rawColumn)) continue;

		// Only rows whose raw column is still NULL are processed: anything this
		// migration already touched carries its preserved originals, so re-runs
		// must never feed the (now canonical) array back into the raw column.
		const rows = sqlite
			.prepare(
				`SELECT id, "${canonicalColumn}" AS value FROM "media_server_synced_items"
				 WHERE "${canonicalColumn}" IS NOT NULL AND "${rawColumn}" IS NULL`
			)
			.all() as Array<{ id: string; value: string }>;
		const update = sqlite.prepare(
			`UPDATE "media_server_synced_items"
			 SET "${canonicalColumn}" = ?, "${rawColumn}" = ? WHERE id = ?`
		);

		let canonicalized = 0;
		let skipped = 0;

		for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
			const pending: Array<{ id: string; canonical: string; raw: string }> = [];
			for (const row of rows.slice(offset, offset + BATCH_SIZE)) {
				let parsed: unknown;
				try {
					parsed = JSON.parse(row.value);
				} catch {
					skipped += 1;
					logger.warn(
						{ itemId: row.id, column: canonicalColumn },
						'[migration v140] Skipped media_server_synced_items row with malformed language JSON'
					);
					continue;
				}

				const split = splitRawAndCanonical(parsed);
				if (!split) {
					skipped += 1;
					logger.warn(
						{ itemId: row.id, column: canonicalColumn },
						'[migration v140] Skipped media_server_synced_items row whose language column is not a JSON array'
					);
					continue;
				}

				pending.push({
					id: row.id,
					canonical: JSON.stringify(split.canonical),
					raw: JSON.stringify(split.raw)
				});
			}
			if (pending.length === 0) continue;
			sqlite.transaction(() => {
				for (const change of pending) update.run(change.canonical, change.raw, change.id);
			})();
			canonicalized += pending.length;
		}

		if (canonicalized > 0 || skipped > 0) {
			logger.info(
				{ column: canonicalColumn, canonicalized, skipped },
				'[migration v140] Canonicalized media_server_synced_items language array'
			);
		}
	}
}

/**
 * Step 3 (Task 3) — add the epg_programs i18n columns (no-op when they already
 * exist). Nullable with no backfill: rows written before this migration keep
 * NULL and readers fall back to the plain text columns.
 */
function addEpgProgramI18nColumns(sqlite: Database.Database): void {
	if (!tableExists(sqlite, 'epg_programs')) return;
	for (const column of EPG_PROGRAM_I18N_COLUMNS) {
		if (columnExists(sqlite, 'epg_programs', column)) continue;
		sqlite.prepare(`ALTER TABLE "epg_programs" ADD COLUMN "${column}" text`).run();
		logger.info(`[migration v140] Added epg_programs.${column}`);
	}
}

/** Final step — integrity gates (report, never fail the migration). */
function runIntegrityChecks(sqlite: Database.Database): void {
	const fkViolations = sqlite.prepare('PRAGMA foreign_key_check').all();
	if (fkViolations.length > 0) {
		logger.warn(
			{ count: fkViolations.length, sample: fkViolations.slice(0, 10) },
			'[migration v140] foreign_key_check reported violations'
		);
	}
	const quickCheck = sqlite.prepare('PRAGMA quick_check').pluck().get() as string | undefined;
	if (quickCheck !== 'ok') {
		logger.warn({ quickCheck }, '[migration v140] quick_check reported problems');
	}
}

export const migration_v143: MigrationDefinition = {
	version: 143,
	name: 'media_server_language_normalization',
	apply: (sqlite: Database.Database) => {
		// Step 1 (Task 2): raw provenance columns on media_server_synced_items.
		addSyncedItemRawLanguageColumns(sqlite);

		// Step 2 (Task 2): canonicalize the stored language arrays in place.
		canonicalizeSyncedItemLanguages(sqlite);

		// Step 3 (Task 3): epg_programs i18n columns for XMLTV @lang preservation.
		addEpgProgramI18nColumns(sqlite);

		// Final: integrity gates.
		runIntegrityChecks(sqlite);
	}
};
