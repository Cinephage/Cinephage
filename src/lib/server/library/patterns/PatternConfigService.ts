/**
 * Pattern Config Service
 *
 * Reads and writes library_pattern_config rows, seeds the global default
 * row on first run, and compiles them into CompiledPatterns for the scanner.
 */

import { db } from '#lib/server/db/index.js';
import { libraryPatternConfig } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
	compilePatterns,
	DEFAULT_IGNORE_PATTERNS,
	DEFAULT_BONUS_FOLDER_NAMES,
	DEFAULT_BONUS_FILE_PATTERNS,
	buildBonusPatterns,
	type CompiledPatterns,
	type PatternConfig
} from '#lib/server/library/patterns/PatternRecognitionService.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PatternRow = typeof libraryPatternConfig.$inferSelect;
export type PatternRowInsert = typeof libraryPatternConfig.$inferInsert;

export interface CreatePatternConfigInput {
	libraryId?: string | null;
	scope: 'global' | 'library';
	ignoreDefaultsEnabled?: boolean;
	ignoreUserPatterns?: string[];
	bonusPatterns?: string[];
	structureMode?: string | null;
	structureConfig?: Record<string, unknown> | null;
}

export interface UpdatePatternConfigInput {
	ignoreDefaultsEnabled?: boolean;
	ignoreUserPatterns?: string[];
	bonusPatterns?: string[];
	structureMode?: string | null;
	structureConfig?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Get (or create) the global default pattern config.
 * Seeds defaults on first run.
 */
export async function getOrCreateGlobalPatternConfig(): Promise<PatternRow> {
	const existing = await db
		.select()
		.from(libraryPatternConfig)
		.where(eq(libraryPatternConfig.scope, 'global'))
		.limit(1)
		.get();

	if (existing) return existing;

	const id = randomUUID();
	const now = new Date().toISOString();
	const defaults: PatternRowInsert = {
		id,
		libraryId: null,
		scope: 'global',
		ignoreDefaultsEnabled: true,
		ignoreUserPatterns: [],
		bonusPatterns: buildBonusPatterns(DEFAULT_BONUS_FOLDER_NAMES, DEFAULT_BONUS_FILE_PATTERNS),
		structureMode: null,
		structureConfig: null,
		createdAt: now,
		updatedAt: now
	};

	await db.insert(libraryPatternConfig).values(defaults).onConflictDoNothing();

	return (await db
		.select()
		.from(libraryPatternConfig)
		.where(eq(libraryPatternConfig.scope, 'global'))
		.limit(1)
		.get())!;
}

/**
 * Get pattern config for a specific library (or null if none).
 */
export async function getLibraryPatternConfig(libraryId: string): Promise<PatternRow | null> {
	return (
		(await db
			.select()
			.from(libraryPatternConfig)
			.where(eq(libraryPatternConfig.libraryId, libraryId))
			.limit(1)
			.get()) ?? null
	);
}

/**
 * Create or update a library-specific pattern config.
 */
export async function saveLibraryPatternConfig(
	libraryId: string,
	input: UpdatePatternConfigInput
): Promise<PatternRow> {
	const existing = await getLibraryPatternConfig(libraryId);
	const now = new Date().toISOString();

	if (existing) {
		await db
			.update(libraryPatternConfig)
			.set({ ...input, updatedAt: now })
			.where(eq(libraryPatternConfig.id, existing.id));

		return (await getLibraryPatternConfig(libraryId))!;
	}

	const id = randomUUID();
	const row: PatternRowInsert = {
		id,
		libraryId,
		scope: 'library',
		ignoreDefaultsEnabled: input.ignoreDefaultsEnabled ?? true,
		ignoreUserPatterns: input.ignoreUserPatterns ?? [],
		bonusPatterns: input.bonusPatterns ?? [],
		structureMode: input.structureMode ?? null,
		structureConfig: input.structureConfig ?? null,
		createdAt: now,
		updatedAt: now
	};

	await db.insert(libraryPatternConfig).values(row);
	return (await getLibraryPatternConfig(libraryId))!;
}

/**
 * Update the global pattern config.
 */
export async function updateGlobalPatternConfig(
	input: UpdatePatternConfigInput
): Promise<PatternRow> {
	const existing = await getOrCreateGlobalPatternConfig();
	const now = new Date().toISOString();

	await db
		.update(libraryPatternConfig)
		.set({ ...input, updatedAt: now })
		.where(eq(libraryPatternConfig.id, existing.id));

	return (await getOrCreateGlobalPatternConfig())!;
}

// ---------------------------------------------------------------------------
// Compile helpers
// ---------------------------------------------------------------------------

/**
 * Compile the effective pattern config for a library by merging its
 * library-level overrides with the global defaults.
 */
export async function compileLibraryPatterns(libraryId: string): Promise<CompiledPatterns> {
	const [global, local] = await Promise.all([
		getOrCreateGlobalPatternConfig(),
		getLibraryPatternConfig(libraryId)
	]);

	const ignoreDefaultsEnabled =
		local?.ignoreDefaultsEnabled ?? global.ignoreDefaultsEnabled ?? true;
	const ignoreUser = local?.ignoreUserPatterns ?? global.ignoreUserPatterns ?? [];
	const bonus = local?.bonusPatterns ?? global.bonusPatterns ?? [];

	let structure: PatternConfig['structure'] = null;
	const structRow = local ?? global;
	if (structRow?.structureMode && structRow.structureMode !== 'none') {
		structure = {
			mode: structRow.structureMode as 'folder_depth' | 'regex',
			seriesFolderDepth:
				typeof structRow.structureConfig === 'object' &&
				structRow.structureConfig &&
				'seriesFolderDepth' in structRow.structureConfig
					? (structRow.structureConfig as Record<string, number>).seriesFolderDepth
					: undefined,
			seasonFolderDepth:
				typeof structRow.structureConfig === 'object' &&
				structRow.structureConfig &&
				'seasonFolderDepth' in structRow.structureConfig
					? (structRow.structureConfig as Record<string, number>).seasonFolderDepth
					: undefined,
			seriesFolderRegexes:
				typeof structRow.structureConfig === 'object' &&
				structRow.structureConfig &&
				'seriesFolderRegexes' in structRow.structureConfig
					? (structRow.structureConfig as Record<string, string[]>).seriesFolderRegexes
					: undefined,
			seasonFolderRegexes:
				typeof structRow.structureConfig === 'object' &&
				structRow.structureConfig &&
				'seasonFolderRegexes' in structRow.structureConfig
					? (structRow.structureConfig as Record<string, string[]>).seasonFolderRegexes
					: undefined,
			episodeFileRegexes:
				typeof structRow.structureConfig === 'object' &&
				structRow.structureConfig &&
				'episodeFileRegexes' in structRow.structureConfig
					? (structRow.structureConfig as Record<string, string[]>).episodeFileRegexes
					: undefined
		};
	}

	return compilePatterns({
		ignore: {
			defaultEnabled: ignoreDefaultsEnabled,
			defaults: DEFAULT_IGNORE_PATTERNS,
			user: ignoreUser
		},
		bonus: { patterns: bonus },
		structure
	});
}
