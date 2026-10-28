import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { indexers, scoringProfiles } from '#lib/server/db/schema.js';
import { and, eq, ne, sql } from 'drizzle-orm';
import { DEFAULT_PROFILES, getProfile, isBuiltInProfile } from '#lib/server/scoring/index.js';
import { qualityFilter } from '#lib/server/quality/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { toNullableNumber } from '#lib/utils/number.js';
import { AppError, NotFoundError, ValidationError, isAppError } from '#lib/errors/index.js';
import { parseBody } from '#lib/server/api/validate.js';
import {
	scoringProfileCreateSchema,
	scoringProfileUpdateBodySchema,
	scoringProfileDeleteSchema
} from '#lib/validation/schemas.js';

const BUILT_IN_IDS = DEFAULT_PROFILES.map((p) => p.id);

/**
 * Run a handler body and map AppError subclasses to their own status codes.
 *
 * Without this every ValidationError / NotFoundError escapes as a 500 from
 * SvelteKit's error hook, so clients cannot tell "you sent something wrong"
 * from "the server broke".
 */
async function withAppErrors(fn: () => Promise<Response>): Promise<Response> {
	try {
		return await fn();
	} catch (error) {
		if (isAppError(error)) {
			return Response.json(error.toJSON(), { status: error.statusCode });
		}
		throw error;
	}
}

function normalizeProfileName(name: string): string {
	return name.trim().toLowerCase();
}

async function findProfileByNameCaseInsensitive(name: string, excludeId?: string) {
	const normalized = normalizeProfileName(name);
	const whereClause = excludeId
		? and(sql`lower(${scoringProfiles.name}) = ${normalized}`, ne(scoringProfiles.id, excludeId))
		: sql`lower(${scoringProfiles.name}) = ${normalized}`;

	const existing = await db
		.select({ id: scoringProfiles.id, name: scoringProfiles.name })
		.from(scoringProfiles)
		.where(whereClause)
		.limit(1);

	return existing[0] ?? null;
}

/**
 * Normalize and validate an indexer allowlist.
 *
 * `null`/undefined means "all indexers". Otherwise every referenced indexer must
 * exist — a stale ID would silently exclude everything and look like a broken
 * profile rather than a deliberate restriction.
 */
async function resolveAllowedIndexerIds(
	value: string[] | null | undefined
): Promise<string[] | null | undefined> {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (value.length === 0) {
		throw new ValidationError('Select at least one indexer, or use all indexers');
	}

	const unique = [...new Set(value)];
	const rows = await db
		.select({ id: indexers.id })
		.from(indexers)
		.where(
			sql`${indexers.id} in (${sql.join(
				unique.map((id) => sql`${id}`),
				sql`, `
			)})`
		);

	const known = new Set(rows.map((row) => row.id));
	const missing = unique.filter((id) => !known.has(id));
	if (missing.length > 0) {
		throw new ValidationError(`Unknown indexer(s): ${missing.join(', ')}`);
	}

	return unique;
}

export const GET: RequestHandler = async () => {
	const dbProfiles = await db.select().from(scoringProfiles);
	const builtInRows = dbProfiles.filter((p) => p.isBuiltIn);
	const customRows = dbProfiles.filter((p) => !p.isBuiltIn);

	const defaultProfileId =
		customRows.find((p) => p.isDefault)?.id ?? builtInRows.find((p) => p.isDefault)?.id;

	const mappedCustomProfiles = customRows.map((p) => ({
		id: p.id,
		name: p.name,
		description: p.description ?? '',
		tags: p.tags ?? [],
		icon: 'Settings',
		color: 'text-base-content',
		category: 'custom' as const,
		upgradesAllowed: p.upgradesAllowed ?? true,
		preventDowngrades: p.preventDowngrades ?? false,
		minScore: p.minScore ?? 0,
		upgradeUntilScore: p.upgradeUntilScore ?? -1,
		minScoreIncrement: p.minScoreIncrement ?? 0,
		formatScores: p.formatScores ?? {},
		requiredFormats: p.requiredFormats ?? [],
		allowedIndexerIds: p.allowedIndexerIds ?? null,
		movieMinSizeGb: toNullableNumber(p.movieMinSizeGb),
		movieMaxSizeGb: toNullableNumber(p.movieMaxSizeGb),
		episodeMinSizeMb: toNullableNumber(p.episodeMinSizeMb),
		episodeMaxSizeMb: toNullableNumber(p.episodeMaxSizeMb),
		isDefault: p.isDefault ?? false,
		isBuiltIn: false
	}));

	const mappedBuiltInProfiles = builtInRows.map((p) => {
		const uiProfile = getProfile(p.id);
		return {
			id: p.id,
			name: p.name,
			description: p.description ?? '',
			tags: p.tags ?? [],
			icon: uiProfile?.icon ?? 'Settings',
			color: uiProfile?.color ?? 'text-base-content',
			category: uiProfile?.category ?? 'quality',
			upgradesAllowed: p.upgradesAllowed ?? true,
			preventDowngrades: p.preventDowngrades ?? false,
			minScore: p.minScore ?? 0,
			upgradeUntilScore: p.upgradeUntilScore ?? -1,
			minScoreIncrement: p.minScoreIncrement ?? 0,
			formatScores: p.formatScores ?? {},
			requiredFormats: p.requiredFormats ?? [],
			allowedIndexerIds: p.allowedIndexerIds ?? null,
			movieMinSizeGb: toNullableNumber(p.movieMinSizeGb),
			movieMaxSizeGb: toNullableNumber(p.movieMaxSizeGb),
			episodeMinSizeMb: toNullableNumber(p.episodeMinSizeMb),
			episodeMaxSizeMb: toNullableNumber(p.episodeMaxSizeMb),
			isDefault: p.isDefault ?? false,
			isBuiltIn: true
		};
	});

	const allProfiles = [...mappedBuiltInProfiles, ...mappedCustomProfiles];

	return Response.json({
		profiles: allProfiles,
		count: allProfiles.length,
		defaultProfileId: defaultProfileId ?? 'balanced'
	});
};

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	return withAppErrors(async () => {
		const { request } = event;
		const data = await parseBody(request, scoringProfileCreateSchema);
		const duplicateByName = await findProfileByNameCaseInsensitive(data.name);
		if (duplicateByName) {
			return Response.json(
				{ error: `Profile with name '${data.name}' already exists` },
				{ status: 409 }
			);
		}

		if (data.id) {
			if (BUILT_IN_IDS.includes(data.id)) {
				throw new ValidationError(`Cannot use reserved profile ID '${data.id}'`);
			}

			const existing = await db
				.select()
				.from(scoringProfiles)
				.where(eq(scoringProfiles.id, data.id));

			if (existing.length > 0) {
				throw new AppError(`Profile with ID '${data.id}' already exists`, 'CONFLICT', 409);
			}
		}

		if (data.isDefault) {
			await db.update(scoringProfiles).set({ isDefault: false });
		}

		let formatScores: Record<string, number> = data.formatScores ?? {};

		const allowedIndexerIds = await resolveAllowedIndexerIds(data.allowedIndexerIds);

		if (data.copyFromId) {
			const builtInProfile = getProfile(data.copyFromId);
			if (builtInProfile) {
				formatScores = { ...builtInProfile.formatScores };
			} else {
				const sourceProfile = await db
					.select()
					.from(scoringProfiles)
					.where(eq(scoringProfiles.id, data.copyFromId));

				if (sourceProfile.length === 0) {
					throw new NotFoundError('Source profile', data.copyFromId);
				}

				formatScores = { ...(sourceProfile[0].formatScores ?? {}) };
			}

			if (data.formatScores) {
				formatScores = { ...formatScores, ...data.formatScores };
			}
		}

		const newProfile = await db
			.insert(scoringProfiles)
			.values({
				id: data.id,
				name: data.name,
				description: data.description,
				upgradesAllowed: data.upgradesAllowed,
				preventDowngrades: data.preventDowngrades ?? true,
				minScore: data.minScore,
				upgradeUntilScore: data.upgradeUntilScore,
				minScoreIncrement: data.minScoreIncrement,
				formatScores,
				requiredFormats: data.requiredFormats,
				allowedIndexerIds: allowedIndexerIds ?? null,
				movieMinSizeGb: data.movieMinSizeGb,
				movieMaxSizeGb: data.movieMaxSizeGb,
				episodeMinSizeMb: data.episodeMinSizeMb,
				episodeMaxSizeMb: data.episodeMaxSizeMb,
				isDefault: data.isDefault
			})
			.returning();

		qualityFilter.clearProfileCache();

		const created = newProfile[0];
		return Response.json(
			{
				...created,
				movieMinSizeGb: toNullableNumber(created.movieMinSizeGb),
				movieMaxSizeGb: toNullableNumber(created.movieMaxSizeGb),
				episodeMinSizeMb: toNullableNumber(created.episodeMinSizeMb),
				episodeMaxSizeMb: toNullableNumber(created.episodeMaxSizeMb)
			},
			{ status: 201 }
		);
	});
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	return withAppErrors(async () => {
		const { request } = event;
		const { id, ...updateData } = await parseBody(request, scoringProfileUpdateBodySchema);

		if (isBuiltInProfile(id)) {
			const builtIn = getProfile(id);
			if (!builtIn) {
				throw new NotFoundError('Built-in profile', id);
			}

			const disallowedFields = [
				'name',
				'description',
				'upgradesAllowed',
				'minScore',
				'upgradeUntilScore',
				'minScoreIncrement',
				'resolutionOrder',
				'allowedProtocols'
			];
			const submittedDisallowed = disallowedFields.filter((f) => f in updateData);
			if (submittedDisallowed.length > 0) {
				throw new ValidationError(
					`Cannot edit these fields on built-in profiles: ${submittedDisallowed.join(', ')}`
				);
			}

			if (updateData.isDefault) {
				await db.update(scoringProfiles).set({ isDefault: false });
			}

			const updateFields: Record<string, unknown> = {
				updatedAt: new Date().toISOString()
			};
			if (updateData.preventDowngrades !== undefined)
				updateFields.preventDowngrades = updateData.preventDowngrades;
			if (updateData.formatScores !== undefined)
				updateFields.formatScores = updateData.formatScores;
			if (updateData.requiredFormats !== undefined)
				updateFields.requiredFormats = updateData.requiredFormats;
			if (updateData.allowedIndexerIds !== undefined)
				updateFields.allowedIndexerIds =
					(await resolveAllowedIndexerIds(updateData.allowedIndexerIds)) ?? null;
			if (updateData.movieMinSizeGb !== undefined)
				updateFields.movieMinSizeGb = toNullableNumber(updateData.movieMinSizeGb);
			if (updateData.movieMaxSizeGb !== undefined)
				updateFields.movieMaxSizeGb = toNullableNumber(updateData.movieMaxSizeGb);
			if (updateData.episodeMinSizeMb !== undefined)
				updateFields.episodeMinSizeMb = toNullableNumber(updateData.episodeMinSizeMb);
			if (updateData.episodeMaxSizeMb !== undefined)
				updateFields.episodeMaxSizeMb = toNullableNumber(updateData.episodeMaxSizeMb);
			if (updateData.isDefault !== undefined) updateFields.isDefault = updateData.isDefault;

			await db.update(scoringProfiles).set(updateFields).where(eq(scoringProfiles.id, id));

			qualityFilter.clearProfileCache(id);

			const updated = await db
				.select()
				.from(scoringProfiles)
				.where(eq(scoringProfiles.id, id))
				.get();

			if (!updated) {
				throw new AppError('Profile not found after update', 'INTERNAL_ERROR', 500);
			}

			return Response.json({
				...builtIn,
				preventDowngrades: updated.preventDowngrades ?? false,
				formatScores: updated.formatScores ?? {},
				allowedIndexerIds: updated.allowedIndexerIds ?? null,
				movieMinSizeGb: toNullableNumber(updated.movieMinSizeGb),
				movieMaxSizeGb: toNullableNumber(updated.movieMaxSizeGb),
				episodeMinSizeMb: toNullableNumber(updated.episodeMinSizeMb),
				episodeMaxSizeMb: toNullableNumber(updated.episodeMaxSizeMb),
				isBuiltIn: true,
				isDefault: updated.isDefault ?? false
			});
		}

		const existing = await db.select().from(scoringProfiles).where(eq(scoringProfiles.id, id));

		if (existing.length === 0) {
			throw new NotFoundError('Profile', id);
		}

		if (updateData.name !== undefined) {
			const duplicateByName = await findProfileByNameCaseInsensitive(updateData.name, id);
			if (duplicateByName) {
				return Response.json(
					{ error: `Profile with name '${updateData.name}' already exists` },
					{ status: 409 }
				);
			}
		}

		if (updateData.isDefault) {
			await db.update(scoringProfiles).set({ isDefault: false });
		}

		const updateFields: Record<string, unknown> = {
			updatedAt: new Date().toISOString()
		};
		if (updateData.name !== undefined) updateFields.name = updateData.name;
		if (updateData.description !== undefined) updateFields.description = updateData.description;
		if (updateData.upgradesAllowed !== undefined)
			updateFields.upgradesAllowed = updateData.upgradesAllowed;
		if (updateData.preventDowngrades !== undefined)
			updateFields.preventDowngrades = updateData.preventDowngrades;
		if (updateData.minScore !== undefined) updateFields.minScore = updateData.minScore;
		if (updateData.upgradeUntilScore !== undefined)
			updateFields.upgradeUntilScore = updateData.upgradeUntilScore;
		if (updateData.minScoreIncrement !== undefined)
			updateFields.minScoreIncrement = updateData.minScoreIncrement;
		if (updateData.formatScores !== undefined) updateFields.formatScores = updateData.formatScores;
		if (updateData.requiredFormats !== undefined)
			updateFields.requiredFormats = updateData.requiredFormats;
		if (updateData.allowedIndexerIds !== undefined)
			updateFields.allowedIndexerIds =
				(await resolveAllowedIndexerIds(updateData.allowedIndexerIds)) ?? null;
		if (updateData.movieMinSizeGb !== undefined)
			updateFields.movieMinSizeGb = updateData.movieMinSizeGb;
		if (updateData.movieMaxSizeGb !== undefined)
			updateFields.movieMaxSizeGb = updateData.movieMaxSizeGb;
		if (updateData.episodeMinSizeMb !== undefined)
			updateFields.episodeMinSizeMb = updateData.episodeMinSizeMb;
		if (updateData.episodeMaxSizeMb !== undefined)
			updateFields.episodeMaxSizeMb = updateData.episodeMaxSizeMb;
		if (updateData.isDefault !== undefined) updateFields.isDefault = updateData.isDefault;

		const updated = await db
			.update(scoringProfiles)
			.set(updateFields)
			.where(eq(scoringProfiles.id, id))
			.returning();

		qualityFilter.clearProfileCache(id);

		const updatedProfile = updated[0];
		return Response.json({
			...updatedProfile,
			movieMinSizeGb: toNullableNumber(updatedProfile.movieMinSizeGb),
			movieMaxSizeGb: toNullableNumber(updatedProfile.movieMaxSizeGb),
			episodeMinSizeMb: toNullableNumber(updatedProfile.episodeMinSizeMb),
			episodeMaxSizeMb: toNullableNumber(updatedProfile.episodeMaxSizeMb)
		});
	});
};

export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	return withAppErrors(async () => {
		const { request } = event;
		const { id } = await parseBody(request, scoringProfileDeleteSchema);

		if (isBuiltInProfile(id)) {
			throw new ValidationError(`Cannot delete built-in profile '${id}'`);
		}

		const deleted = await db.delete(scoringProfiles).where(eq(scoringProfiles.id, id)).returning();

		if (deleted.length === 0) {
			throw new NotFoundError('Profile', id);
		}

		qualityFilter.clearProfileCache(id);

		return Response.json({ success: true, deleted: deleted[0] });
	});
};
