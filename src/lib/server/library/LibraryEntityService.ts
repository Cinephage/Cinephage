import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import {
	libraries,
	libraryRootFolders,
	languageProfiles,
	movies,
	rootFolders,
	series
} from '#lib/server/db/schema.js';
import { NotFoundError, ValidationError } from '#lib/errors/index.js';

export type LibraryMediaType = 'movie' | 'tv';
export type LibraryMediaSubType = 'standard' | 'anime';

export interface LibraryRootFolder {
	id: string;
	name: string;
	path: string;
	mediaType: LibraryMediaType;
	mediaSubType: LibraryMediaSubType;
}

export interface LibraryEntity {
	id: string;
	name: string;
	slug: string;
	mediaType: LibraryMediaType;
	mediaSubType: LibraryMediaSubType;
	isSystem: boolean;
	systemKey: string | null;
	isDefault: boolean;
	rootFolders: LibraryRootFolder[];
	defaultRootFolderId: string | null;
	defaultRootFolderPath: string | null;
	defaultSearchOnAdd: boolean;
	defaultWantsSubtitles: boolean;
	qualityProfileId: string | null;
	/** Library-wide default language profile; null = inherit the instance default */
	languageProfileId: string | null;
	sortOrder: number;
	scanMode?: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface CreateLibraryInput {
	name: string;
	mediaType: LibraryMediaType;
	mediaSubType?: LibraryMediaSubType;
	rootFolderIds?: string[];
	isDefault?: boolean;
	defaultSearchOnAdd?: boolean;
	defaultWantsSubtitles?: boolean;
	qualityProfileId?: string | null;
	/** Library-wide default language profile; null = inherit the instance default */
	languageProfileId?: string | null;
	sortOrder?: number;
	scanMode?: string;
	scanConfig?: Record<string, unknown> | null;
}

export type UpdateLibraryInput = Partial<CreateLibraryInput>;

interface ListOptions {
	mediaType?: LibraryMediaType;
	includeSystem?: boolean;
	includeHiddenEmptySystemAnime?: boolean;
}

const SYSTEM_LIBRARY_DEFS: Array<{
	id: string;
	name: string;
	slug: string;
	mediaType: LibraryMediaType;
	mediaSubType: LibraryMediaSubType;
	systemKey: string;
	isDefault: boolean;
	sortOrder: number;
}> = [
	{
		id: 'lib-movies-standard',
		name: 'Movies',
		slug: 'movies',
		mediaType: 'movie',
		mediaSubType: 'standard',
		systemKey: 'movies_standard',
		isDefault: true,
		sortOrder: 0
	},
	{
		id: 'lib-movies-anime',
		name: 'Anime Movies',
		slug: 'anime-movies',
		mediaType: 'movie',
		mediaSubType: 'anime',
		systemKey: 'movies_anime',
		isDefault: false,
		sortOrder: 10
	},
	{
		id: 'lib-tv-standard',
		name: 'TV Shows',
		slug: 'tv-shows',
		mediaType: 'tv',
		mediaSubType: 'standard',
		systemKey: 'tv_standard',
		isDefault: true,
		sortOrder: 0
	},
	{
		id: 'lib-tv-anime',
		name: 'Anime Series',
		slug: 'anime-series',
		mediaType: 'tv',
		mediaSubType: 'anime',
		systemKey: 'tv_anime',
		isDefault: false,
		sortOrder: 10
	}
];

function normalizeMediaSubType(input?: string | null): LibraryMediaSubType {
	if (input === 'anime') {
		return 'anime';
	}
	return 'standard';
}

function slugify(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
}

function uniqueStringArray(values: string[] | undefined): string[] {
	if (!values || values.length === 0) return [];
	return [...new Set(values.filter((value) => value.trim().length > 0))];
}

async function ensureRootFoldersMatchLibrary(
	rootFolderIds: string[] | undefined,
	mediaType: LibraryMediaType,
	mediaSubType: LibraryMediaSubType
): Promise<void> {
	if (!rootFolderIds || rootFolderIds.length === 0) return;

	for (const rootFolderId of rootFolderIds) {
		const [folder] = await db
			.select({
				id: rootFolders.id,
				mediaType: rootFolders.mediaType,
				mediaSubType: rootFolders.mediaSubType
			})
			.from(rootFolders)
			.where(eq(rootFolders.id, rootFolderId))
			.limit(1);

		if (!folder) {
			throw new NotFoundError('Root folder', rootFolderId);
		}
		if (folder.mediaType !== mediaType) {
			const expectedLabel = mediaType === 'movie' ? 'Movies' : 'TV Shows';
			throw new ValidationError(`Root folder must be configured for ${expectedLabel}`);
		}
		if (normalizeMediaSubType(folder.mediaSubType) !== mediaSubType) {
			const expectedLabel = mediaSubType === 'anime' ? 'anime' : 'standard';
			throw new ValidationError(`Root folder must use the ${expectedLabel} media classification`);
		}
	}
}

async function getRootFoldersForLibraries(libraryIds: string[]): Promise<
	Array<{
		libraryId: string;
		id: string;
		name: string;
		path: string;
		mediaType: string;
		mediaSubType: string;
		isDefault: boolean;
	}>
> {
	if (libraryIds.length === 0) return [];

	return await db
		.select({
			libraryId: libraryRootFolders.libraryId,
			id: rootFolders.id,
			name: rootFolders.name,
			path: rootFolders.path,
			mediaType: rootFolders.mediaType,
			mediaSubType: rootFolders.mediaSubType,
			isDefault: libraryRootFolders.isDefault
		})
		.from(libraryRootFolders)
		.innerJoin(rootFolders, eq(libraryRootFolders.rootFolderId, rootFolders.id))
		.where(
			sql`${libraryRootFolders.libraryId} IN (${sql.join(
				libraryIds.map((id) => sql`${id}`),
				sql`, `
			)})`
		)
		.orderBy(
			asc(libraryRootFolders.libraryId),
			desc(libraryRootFolders.isDefault),
			asc(rootFolders.createdAt)
		);
}

function getSystemLibraryDefinition(
	mediaType: LibraryMediaType,
	mediaSubType: LibraryMediaSubType
): (typeof SYSTEM_LIBRARY_DEFS)[number] {
	const definition = SYSTEM_LIBRARY_DEFS.find(
		(def) => def.mediaType === mediaType && def.mediaSubType === mediaSubType
	);

	if (!definition) {
		throw new Error(`Missing system library definition for ${mediaType}/${mediaSubType}`);
	}

	return definition;
}

export class LibraryEntityService {
	private _rootFolderBackfillComplete = false;

	private async backfillLibraryRootFolders(): Promise<void> {
		if (this._rootFolderBackfillComplete) {
			return;
		}

		const libraryRows = await db
			.select({
				id: libraries.id,
				mediaType: libraries.mediaType,
				mediaSubType: libraries.mediaSubType,
				defaultRootFolderId: libraries.defaultRootFolderId
			})
			.from(libraries);

		const existingAssignments = await db
			.select({
				libraryId: libraryRootFolders.libraryId,
				rootFolderId: libraryRootFolders.rootFolderId
			})
			.from(libraryRootFolders);

		const assigned = new Set(
			existingAssignments.map((row) => `${row.libraryId}:${row.rootFolderId}`)
		);
		const assignedRootFolderIds = new Set(existingAssignments.map((row) => row.rootFolderId));

		const rowsToInsert: Array<{
			libraryId: string;
			rootFolderId: string;
			isDefault: boolean;
			createdAt: string;
		}> = [];
		const now = new Date().toISOString();

		for (const library of libraryRows) {
			const fallbackRootFolder = library.defaultRootFolderId;
			if (!fallbackRootFolder || assignedRootFolderIds.has(fallbackRootFolder)) {
				continue;
			}

			const key = `${library.id}:${fallbackRootFolder}`;
			if (assigned.has(key)) {
				continue;
			}

			rowsToInsert.push({
				libraryId: library.id,
				rootFolderId: fallbackRootFolder,
				isDefault: true,
				createdAt: now
			});
			assigned.add(key);
			assignedRootFolderIds.add(fallbackRootFolder);
		}

		if (rowsToInsert.length > 0) {
			await db.insert(libraryRootFolders).values(rowsToInsert).onConflictDoNothing();
		}

		this._rootFolderBackfillComplete = true;
	}

	private async loadLibraryEntities(options: ListOptions = {}): Promise<LibraryEntity[]> {
		const includeSystem = options.includeSystem ?? true;
		// Reconciliation (syncSystemLibrariesFromRootFolders + backfillLibraryRootFolders)
		// was previously triggered here, causing writes on every read path (listLibraries,
		// getLibrary, getLibraryForMutation). Reconciliation now runs from write paths
		// (assignRootFoldersToLibrary / releaseRootFoldersToSystemLibraries) and the
		// library-reconcile scheduled task. See reconcileAll().

		const rows = await db
			.select({
				id: libraries.id,
				name: libraries.name,
				slug: libraries.slug,
				mediaType: libraries.mediaType,
				mediaSubType: libraries.mediaSubType,
				isSystem: libraries.isSystem,
				systemKey: libraries.systemKey,
				isDefault: libraries.isDefault,
				defaultRootFolderId: libraries.defaultRootFolderId,
				defaultSearchOnAdd: libraries.defaultSearchOnAdd,
				defaultWantsSubtitles: libraries.defaultWantsSubtitles,
				qualityProfileId: libraries.qualityProfileId,
				languageProfileId: libraries.languageProfileId,
				sortOrder: libraries.sortOrder,
				scanMode: libraries.scanMode,
				createdAt: libraries.createdAt,
				updatedAt: libraries.updatedAt
			})
			.from(libraries)
			.where(
				and(
					options.mediaType ? eq(libraries.mediaType, options.mediaType) : undefined,
					includeSystem ? undefined : eq(libraries.isSystem, false)
				)
			)
			.orderBy(
				asc(libraries.mediaType),
				asc(libraries.sortOrder),
				desc(libraries.isSystem),
				asc(libraries.name)
			);

		const rootFolderRows = await getRootFoldersForLibraries(rows.map((row) => row.id));
		const rootFoldersByLibraryId = new Map<string, LibraryRootFolder[]>();
		const defaultPathByLibraryId = new Map<string, string | null>();

		for (const row of rootFolderRows) {
			const list = rootFoldersByLibraryId.get(row.libraryId) ?? [];
			const rootFolder: LibraryRootFolder = {
				id: row.id,
				name: row.name,
				path: row.path,
				mediaType: row.mediaType as LibraryMediaType,
				mediaSubType: normalizeMediaSubType(row.mediaSubType)
			};
			list.push(rootFolder);
			rootFoldersByLibraryId.set(row.libraryId, list);

			if (row.isDefault) {
				defaultPathByLibraryId.set(row.libraryId, row.path);
			}
		}

		return rows.flatMap((row) => {
			const attachedRootFolders = rootFoldersByLibraryId.get(row.id) ?? [];
			const isHiddenEmptySystemAnimeLibrary =
				!options.includeHiddenEmptySystemAnime &&
				(row.isSystem ?? false) &&
				normalizeMediaSubType(row.mediaSubType) === 'anime' &&
				attachedRootFolders.length === 0;

			if (isHiddenEmptySystemAnimeLibrary) {
				return [];
			}

			const fallbackDefaultFolder = attachedRootFolders[0] ?? null;
			const defaultRootFolderId = row.defaultRootFolderId ?? fallbackDefaultFolder?.id ?? null;
			return {
				id: row.id,
				name: row.name,
				slug: row.slug,
				mediaType: row.mediaType as LibraryMediaType,
				mediaSubType: normalizeMediaSubType(row.mediaSubType),
				isSystem: row.isSystem ?? false,
				systemKey: row.systemKey ?? null,
				isDefault: row.isDefault ?? false,
				rootFolders: attachedRootFolders,
				defaultRootFolderId,
				defaultRootFolderPath:
					defaultPathByLibraryId.get(row.id) ??
					attachedRootFolders.find((folder) => folder.id === defaultRootFolderId)?.path ??
					null,
				defaultSearchOnAdd: row.defaultSearchOnAdd ?? true,
				defaultWantsSubtitles: row.defaultWantsSubtitles ?? true,
				qualityProfileId: row.qualityProfileId ?? null,
				languageProfileId: row.languageProfileId ?? null,
				sortOrder: row.sortOrder ?? 0,
				createdAt: row.createdAt ?? '',
				updatedAt: row.updatedAt ?? ''
			};
		});
	}

	private async ensureSystemLibraryRecords(): Promise<void> {
		const now = new Date().toISOString();

		for (const def of SYSTEM_LIBRARY_DEFS) {
			await db
				.insert(libraries)
				.values({
					id: def.id,
					name: def.name,
					slug: def.slug,
					mediaType: def.mediaType,
					mediaSubType: def.mediaSubType,
					isSystem: true,
					systemKey: def.systemKey,
					isDefault: def.isDefault,
					defaultRootFolderId: null,
					defaultSearchOnAdd: true,
					defaultWantsSubtitles: true,
					sortOrder: def.sortOrder,
					createdAt: now,
					updatedAt: now
				})
				.onConflictDoUpdate({
					target: libraries.systemKey,
					set: {
						name: def.name,
						slug: def.slug,
						mediaType: def.mediaType,
						mediaSubType: def.mediaSubType,
						isDefault: def.isDefault,
						sortOrder: def.sortOrder,
						updatedAt: now
					}
				});
		}
	}

	private async normalizeLibraryRootFolderState(libraryId: string): Promise<void> {
		const library = await db
			.select({
				id: libraries.id,
				isSystem: libraries.isSystem
			})
			.from(libraries)
			.where(eq(libraries.id, libraryId))
			.limit(1)
			.get();

		if (!library) {
			return;
		}

		const attachments = await db
			.select({
				rootFolderId: libraryRootFolders.rootFolderId,
				isDefault: libraryRootFolders.isDefault,
				createdAt: libraryRootFolders.createdAt,
				defaultMonitored: rootFolders.defaultMonitored
			})
			.from(libraryRootFolders)
			.innerJoin(rootFolders, eq(libraryRootFolders.rootFolderId, rootFolders.id))
			.where(eq(libraryRootFolders.libraryId, libraryId))
			.orderBy(desc(libraryRootFolders.isDefault), asc(libraryRootFolders.createdAt));

		const defaultAttachment = attachments[0] ?? null;
		const defaultRootFolderId = defaultAttachment?.rootFolderId ?? null;
		const now = new Date().toISOString();

		await db
			.update(libraryRootFolders)
			.set({ isDefault: false })
			.where(eq(libraryRootFolders.libraryId, libraryId));

		if (defaultRootFolderId) {
			await db
				.update(libraryRootFolders)
				.set({ isDefault: true })
				.where(
					and(
						eq(libraryRootFolders.libraryId, libraryId),
						eq(libraryRootFolders.rootFolderId, defaultRootFolderId)
					)
				);
		}

		const updateData: Record<string, unknown> = {
			defaultRootFolderId,
			updatedAt: now
		};

		await db.update(libraries).set(updateData).where(eq(libraries.id, libraryId));
	}

	private async reconcileRootFolderAssignments(rootFolderIds?: string[]): Promise<void> {
		await this.ensureSystemLibraryRecords();

		const scopedRootFolderIds = rootFolderIds?.filter((id) => id.trim().length > 0);
		const targetRootFolders = await db
			.select({
				id: rootFolders.id,
				mediaType: rootFolders.mediaType,
				mediaSubType: rootFolders.mediaSubType
			})
			.from(rootFolders)
			.where(
				scopedRootFolderIds && scopedRootFolderIds.length > 0
					? inArray(rootFolders.id, scopedRootFolderIds)
					: undefined
			);

		const assignments = await db
			.select({
				rootFolderId: libraryRootFolders.rootFolderId,
				libraryId: libraryRootFolders.libraryId,
				libraryMediaType: libraries.mediaType,
				libraryMediaSubType: libraries.mediaSubType,
				isSystem: libraries.isSystem
			})
			.from(libraryRootFolders)
			.innerJoin(libraries, eq(libraryRootFolders.libraryId, libraries.id))
			.where(
				scopedRootFolderIds && scopedRootFolderIds.length > 0
					? inArray(libraryRootFolders.rootFolderId, scopedRootFolderIds)
					: undefined
			)
			.orderBy(asc(libraries.isSystem), asc(libraryRootFolders.createdAt));

		const assignmentsByRootFolder = new Map<string, typeof assignments>();
		for (const assignment of assignments) {
			const list = assignmentsByRootFolder.get(assignment.rootFolderId) ?? [];
			list.push(assignment);
			assignmentsByRootFolder.set(assignment.rootFolderId, list);
		}

		const now = new Date().toISOString();
		for (const folder of targetRootFolders) {
			const normalizedSubType = normalizeMediaSubType(folder.mediaSubType);
			const compatibleAssignments =
				assignmentsByRootFolder
					.get(folder.id)
					?.filter(
						(assignment) =>
							assignment.libraryMediaType === folder.mediaType &&
							normalizeMediaSubType(assignment.libraryMediaSubType) === normalizedSubType
					) ?? [];
			const preferredLibraryId =
				compatibleAssignments.find((assignment) => !assignment.isSystem)?.libraryId ??
				compatibleAssignments[0]?.libraryId ??
				getSystemLibraryDefinition(folder.mediaType as LibraryMediaType, normalizedSubType).id;

			await db.delete(libraryRootFolders).where(eq(libraryRootFolders.rootFolderId, folder.id));
			await db
				.insert(libraryRootFolders)
				.values({
					libraryId: preferredLibraryId,
					rootFolderId: folder.id,
					isDefault: false,
					createdAt: now
				})
				.onConflictDoNothing();
		}

		const allLibraries = await db.select({ id: libraries.id }).from(libraries);
		for (const library of allLibraries) {
			await this.normalizeLibraryRootFolderState(library.id);
		}

		await this.syncMediaLibraryIdsForRootFolders(targetRootFolders.map((folder) => folder.id));
	}

	private async syncMediaLibraryIdsForRootFolders(rootFolderIds: string[]): Promise<void> {
		if (rootFolderIds.length === 0) {
			return;
		}

		const assignments = await db
			.select({
				rootFolderId: libraryRootFolders.rootFolderId,
				libraryId: libraryRootFolders.libraryId,
				mediaType: libraries.mediaType
			})
			.from(libraryRootFolders)
			.innerJoin(libraries, eq(libraryRootFolders.libraryId, libraries.id))
			.where(inArray(libraryRootFolders.rootFolderId, rootFolderIds));

		for (const assignment of assignments) {
			if (assignment.mediaType === 'movie') {
				await db
					.update(movies)
					.set({ libraryId: assignment.libraryId })
					.where(eq(movies.rootFolderId, assignment.rootFolderId));
			} else {
				await db
					.update(series)
					.set({ libraryId: assignment.libraryId })
					.where(eq(series.rootFolderId, assignment.rootFolderId));
			}
		}
	}

	async syncSystemLibrariesFromRootFolders(): Promise<void> {
		await this.reconcileRootFolderAssignments();
	}

	/**
	 * Run full library <-> root folder reconciliation.
	 * Called from write paths and the library-reconcile scheduled task.
	 * Performs: backfillLibraryRootFolders + syncSystemLibrariesFromRootFolders
	 * (which delegates to reconcileRootFolderAssignments).
	 *
	 * This is the canonical entry point for healing drift between libraries,
	 * root folders, and their join-table assignments. Read paths
	 * (listLibraries / getLibrary) no longer reconcile implicitly.
	 */
	async reconcileAll(): Promise<void> {
		await this.backfillLibraryRootFolders();
		await this.syncSystemLibrariesFromRootFolders();
	}

	async resolveOwningLibraryForRootFolder(
		rootFolderId: string,
		mediaType: LibraryMediaType
	): Promise<LibraryEntity> {
		await this.reconcileRootFolderAssignments([rootFolderId]);

		const assignment = await db
			.select({
				libraryId: libraryRootFolders.libraryId
			})
			.from(libraryRootFolders)
			.innerJoin(libraries, eq(libraryRootFolders.libraryId, libraries.id))
			.where(
				and(eq(libraryRootFolders.rootFolderId, rootFolderId), eq(libraries.mediaType, mediaType))
			)
			.limit(1)
			.get();

		if (!assignment?.libraryId) {
			throw new ValidationError('No library is assigned to the selected root folder', {
				rootFolderId,
				mediaType
			});
		}

		const library = await this.getLibrary(assignment.libraryId);
		if (!library) {
			throw new NotFoundError('Library', assignment.libraryId);
		}

		return library;
	}

	private async assignRootFoldersToLibrary(
		libraryId: string,
		rootFolderIds: string[] | undefined
	): Promise<void> {
		if (rootFolderIds === undefined) {
			return;
		}

		await db.delete(libraryRootFolders).where(eq(libraryRootFolders.libraryId, libraryId));

		if (rootFolderIds.length > 0) {
			await db
				.delete(libraryRootFolders)
				.where(inArray(libraryRootFolders.rootFolderId, rootFolderIds));
			await db
				.insert(libraryRootFolders)
				.values(
					rootFolderIds.map((rootFolderId, index) => ({
						libraryId,
						rootFolderId,
						isDefault: index === 0,
						createdAt: new Date().toISOString()
					}))
				)
				.onConflictDoNothing();
		}

		await this.reconcileRootFolderAssignments();
	}

	private async releaseRootFoldersToSystemLibraries(rootFolderIds: string[]): Promise<void> {
		if (rootFolderIds.length === 0) {
			await this.reconcileRootFolderAssignments();
			return;
		}

		await db
			.delete(libraryRootFolders)
			.where(inArray(libraryRootFolders.rootFolderId, rootFolderIds));

		await this.reconcileRootFolderAssignments();
	}

	async listLibraries(options: ListOptions = {}): Promise<LibraryEntity[]> {
		return this.loadLibraryEntities(options);
	}

	async getLibrary(id: string): Promise<LibraryEntity | null> {
		const rows = await this.loadLibraryEntities();
		return rows.find((row) => row.id === id) ?? null;
	}

	private async getLibraryForMutation(id: string): Promise<LibraryEntity | null> {
		const rows = await this.loadLibraryEntities({ includeHiddenEmptySystemAnime: true });
		return rows.find((row) => row.id === id) ?? null;
	}

	async resolveDefaultRootFolderForLibrary(
		libraryId: string,
		mediaType: LibraryMediaType
	): Promise<{ library: LibraryEntity; rootFolderId: string; rootFolderPath: string }> {
		const library = await this.getLibrary(libraryId);
		if (!library) {
			throw new NotFoundError('Library', libraryId);
		}
		if (library.mediaType !== mediaType) {
			const expected = mediaType === 'movie' ? 'Movies' : 'TV Shows';
			throw new ValidationError(`Selected destination library must be a ${expected} library`);
		}

		const compatibleRootFolder =
			library.rootFolders.find((folder) => folder.id === library.defaultRootFolderId) ??
			library.rootFolders[0];
		if (!compatibleRootFolder) {
			throw new ValidationError(
				'Selected destination library has no default root folder configured'
			);
		}
		if (
			compatibleRootFolder.mediaType !== mediaType ||
			compatibleRootFolder.mediaSubType !== library.mediaSubType
		) {
			throw new ValidationError('Selected destination library points to an invalid root folder');
		}

		return {
			library,
			rootFolderId: compatibleRootFolder.id,
			rootFolderPath: compatibleRootFolder.path
		};
	}

	async createLibrary(input: CreateLibraryInput): Promise<LibraryEntity> {
		const mediaSubType = input.mediaSubType ?? 'standard';
		const rootFolderIds = uniqueStringArray(input.rootFolderIds);
		await ensureRootFoldersMatchLibrary(rootFolderIds, input.mediaType, mediaSubType);
		const languageProfileId = await this.resolveLibraryLanguageProfileId(input.languageProfileId);

		const now = new Date().toISOString();
		const id = randomUUID();
		const slug = await this.buildUniqueSlug(input.name, input.mediaType);
		const nextSortOrder =
			input.sortOrder ??
			((
				await db
					.select({ maxSort: sql<number>`COALESCE(MAX(${libraries.sortOrder}), 0)` })
					.from(libraries)
					.where(eq(libraries.mediaType, input.mediaType))
					.get()
			)?.maxSort ?? 0) + 10;

		if (input.isDefault) {
			await db
				.update(libraries)
				.set({ isDefault: false, updatedAt: now })
				.where(eq(libraries.mediaType, input.mediaType));
		}

		await db.insert(libraries).values({
			id,
			name: input.name.trim(),
			slug,
			mediaType: input.mediaType,
			mediaSubType,
			isSystem: false,
			systemKey: null,
			isDefault: input.isDefault ?? false,
			defaultRootFolderId: null,
			defaultSearchOnAdd: input.defaultSearchOnAdd ?? true,
			defaultWantsSubtitles: input.defaultWantsSubtitles ?? true,
			qualityProfileId: input.qualityProfileId || null,
			languageProfileId,
			sortOrder: nextSortOrder,
			scanMode: input.scanMode ?? 'scheduled',
			scanConfig: input.scanConfig ?? null,
			createdAt: now,
			updatedAt: now
		});

		await this.assignRootFoldersToLibrary(id, rootFolderIds);

		const created = await this.getLibrary(id);
		if (!created) {
			throw new Error('Failed to create library');
		}
		return created;
	}

	async updateLibrary(id: string, updates: UpdateLibraryInput): Promise<LibraryEntity> {
		const existing = await this.getLibrary(id);
		if (!existing) {
			throw new NotFoundError('Library', id);
		}

		if (existing.isSystem && updates.name && updates.name.trim() !== existing.name) {
			throw new ValidationError('System libraries cannot be renamed');
		}
		if (existing.isSystem && updates.mediaType && updates.mediaType !== existing.mediaType) {
			throw new ValidationError('System libraries cannot change media type');
		}
		if (
			existing.isSystem &&
			updates.mediaSubType &&
			normalizeMediaSubType(updates.mediaSubType) !== existing.mediaSubType
		) {
			throw new ValidationError('System libraries cannot change media classification');
		}

		const mediaType = updates.mediaType ?? existing.mediaType;
		const mediaSubType = updates.mediaSubType
			? normalizeMediaSubType(updates.mediaSubType)
			: existing.mediaSubType;
		const rootFolderIds =
			updates.rootFolderIds !== undefined ? uniqueStringArray(updates.rootFolderIds) : undefined;
		if (rootFolderIds !== undefined) {
			await ensureRootFoldersMatchLibrary(rootFolderIds, mediaType, mediaSubType);
		}

		if (updates.isDefault) {
			await db
				.update(libraries)
				.set({ isDefault: false, updatedAt: new Date().toISOString() })
				.where(and(eq(libraries.mediaType, mediaType), ne(libraries.id, id)));
		}

		const updateData: Record<string, unknown> = {
			updatedAt: new Date().toISOString()
		};
		if (updates.name !== undefined) {
			updateData.name = updates.name.trim();
			if (!existing.isSystem) {
				updateData.slug = await this.buildUniqueSlug(updates.name, mediaType, id);
			}
		}
		if (updates.mediaType !== undefined && !existing.isSystem) {
			updateData.mediaType = updates.mediaType;
		}
		if (updates.mediaSubType !== undefined && !existing.isSystem) {
			updateData.mediaSubType = normalizeMediaSubType(updates.mediaSubType);
		}
		if (updates.isDefault !== undefined) {
			updateData.isDefault = updates.isDefault;
		}
		if (updates.defaultSearchOnAdd !== undefined) {
			updateData.defaultSearchOnAdd = updates.defaultSearchOnAdd;
		}
		if (updates.defaultWantsSubtitles !== undefined) {
			updateData.defaultWantsSubtitles = updates.defaultWantsSubtitles;
		}
		if (updates.qualityProfileId !== undefined) {
			updateData.qualityProfileId = updates.qualityProfileId || null;
		}
		if (updates.languageProfileId !== undefined) {
			updateData.languageProfileId = await this.resolveLibraryLanguageProfileId(
				updates.languageProfileId
			);
		}
		if (updates.sortOrder !== undefined) {
			updateData.sortOrder = updates.sortOrder;
		}
		if (updates.scanMode !== undefined) {
			updateData.scanMode = updates.scanMode;
		}
		if (updates.scanConfig !== undefined) {
			updateData.scanConfig = updates.scanConfig ?? null;
		}

		await db.update(libraries).set(updateData).where(eq(libraries.id, id));

		await this.assignRootFoldersToLibrary(id, rootFolderIds);

		const updated = await this.getLibrary(id);
		if (!updated) {
			throw new Error('Failed to update library');
		}
		return updated;
	}

	private async resolveLibraryDeletionTarget(
		library: LibraryEntity,
		targetLibraryId?: string | null
	): Promise<string | null> {
		if (library.rootFolders.length === 0) {
			return null;
		}

		const allLibraries = await this.loadLibraryEntities({
			mediaType: library.mediaType,
			includeHiddenEmptySystemAnime: true
		});
		const systemLibraryId = getSystemLibraryDefinition(library.mediaType, library.mediaSubType).id;

		if (targetLibraryId) {
			const targetLibrary = allLibraries.find((candidate) => candidate.id === targetLibraryId);
			if (!targetLibrary) {
				throw new NotFoundError('Library', targetLibraryId);
			}
			if (targetLibrary.id === library.id) {
				throw new ValidationError('Cannot move root folders into the library being deleted');
			}
			if (
				targetLibrary.mediaType !== library.mediaType ||
				targetLibrary.mediaSubType !== library.mediaSubType
			) {
				throw new ValidationError('Selected target library is not compatible with this library');
			}
			return targetLibrary.id;
		}

		return systemLibraryId;
	}

	async deleteLibrary(id: string, targetLibraryId?: string | null): Promise<void> {
		const existing = await this.getLibraryForMutation(id);
		if (!existing) {
			throw new NotFoundError('Library', id);
		}
		if (existing.isSystem) {
			throw new ValidationError('System libraries cannot be deleted');
		}

		const attachedRootFolderIds = existing.rootFolders.map((folder) => folder.id);
		const destinationLibraryId = await this.resolveLibraryDeletionTarget(existing, targetLibraryId);
		if (destinationLibraryId) {
			const destinationLibrary = await this.getLibraryForMutation(destinationLibraryId);
			if (!destinationLibrary) {
				throw new NotFoundError('Library', destinationLibraryId);
			}
			const nextRootFolderIds = [
				...destinationLibrary.rootFolders.map((folder) => folder.id),
				...attachedRootFolderIds
			];
			await this.assignRootFoldersToLibrary(destinationLibrary.id, nextRootFolderIds);
		}

		await db.delete(libraryRootFolders).where(eq(libraryRootFolders.libraryId, id));
		await db.delete(libraries).where(eq(libraries.id, id));
	}

	/**
	 * Validate a library language profile reference. Empty/undefined values
	 * normalize to null (= inherit the instance default); a non-empty value
	 * must reference an existing language profile.
	 */
	private async resolveLibraryLanguageProfileId(
		value: string | null | undefined
	): Promise<string | null> {
		if (!value) return null;
		const [profile] = await db
			.select({ id: languageProfiles.id })
			.from(languageProfiles)
			.where(eq(languageProfiles.id, value))
			.limit(1);
		if (!profile) {
			throw new ValidationError(`Language profile not found: ${value}`);
		}
		return value;
	}

	private async buildUniqueSlug(
		name: string,
		mediaType: LibraryMediaType,
		excludeId?: string
	): Promise<string> {
		const base = slugify(name) || `${mediaType}-library`;
		let candidate = base;
		let suffix = 2;

		while (true) {
			const [existing] = await db
				.select({ id: libraries.id })
				.from(libraries)
				.where(
					and(eq(libraries.slug, candidate), excludeId ? ne(libraries.id, excludeId) : undefined)
				)
				.limit(1);

			if (!existing) {
				return candidate;
			}

			candidate = `${base}-${suffix}`;
			suffix += 1;
		}
	}
}

let _libraryEntityService: LibraryEntityService | null = null;

export function getLibraryEntityService(): LibraryEntityService {
	if (!_libraryEntityService) {
		_libraryEntityService = new LibraryEntityService();
	}
	return _libraryEntityService;
}
