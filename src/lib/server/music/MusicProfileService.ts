import { and, asc, eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import {
	albums,
	artists,
	libraries,
	scoringProfiles,
	settings,
	type MusicProfileTierRow
} from '#lib/server/db/schema.js';
import { ValidationError } from '#lib/errors/index.js';
import {
	DEFAULT_MUSIC_PROFILE,
	type MusicFormat,
	type MusicQualityProfile,
	type MusicTier
} from './parse-release.js';

const SETTINGS_KEY = 'music_quality';
const FALLBACK_PROFILE_ID = 'music-default';

export interface MusicProfile {
	id: string;
	name: string;
	description: string | null;
	tiers: MusicProfileTierRow[];
	allowFallback: boolean;
	/** MB of audio; null on either side means no bound. */
	minSizeMb: number | null;
	maxSizeMb: number | null;
	isDefault: boolean;
	isBuiltIn: boolean;
	sortOrder: number;
}

export interface MusicProfileInput {
	name: string;
	description?: string | null;
	tiers: MusicProfileTierRow[];
	allowFallback?: boolean;
	minSizeMb?: number | null;
	maxSizeMb?: number | null;
}

function toPublic(
	row: typeof scoringProfiles.$inferSelect,
	defaultId: string | null
): MusicProfile {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		tiers: row.musicTiers ?? [],
		allowFallback: row.musicAllowFallback ?? true,
		minSizeMb: row.musicMinSizeMb ?? null,
		maxSizeMb: row.musicMaxSizeMb ?? null,
		isDefault: row.id === defaultId,
		isBuiltIn: row.isBuiltIn ?? false,
		sortOrder: 0
	};
}

/** The DB ladder is the policy; this is the shape grading understands. */
function toQualityProfile(row: MusicProfile): MusicQualityProfile {
	return {
		id: row.id,
		name: row.name,
		tiers: row.tiers.map((tier): MusicTier => ({
			kind: tier.kind,
			label: tier.label,
			formats: tier.formats as MusicFormat[] | undefined,
			// `kind` is what the row stores; the grader needs the derived
			// lossless constraint too, or a no-formats lossless rung matches
			// an MP3 as rung 0.
			lossless: tier.kind === 'lossless' ? true : tier.kind === 'lossy' ? false : undefined,
			minBitrateKbps: tier.minBitrateKbps,
			minBitDepth: tier.minBitDepth
		})),
		allowFallback: row.allowFallback,
		formatScores: DEFAULT_MUSIC_PROFILE.formatScores,
		minSizeMb: row.minSizeMb,
		maxSizeMb: row.maxSizeMb
	};
}

function validateTiers(tiers: MusicProfileTierRow[]): MusicProfileTierRow[] {
	if (!Array.isArray(tiers) || tiers.length === 0) {
		throw new ValidationError('A music profile needs at least one tier');
	}
	const kinds = new Set(['lossless', 'lossy', 'streaming']);
	return tiers.map((tier, index) => {
		if (!kinds.has(tier.kind)) {
			throw new ValidationError(`Tier ${index + 1} has an unknown kind`);
		}
		const label = tier.label?.trim();
		if (!label) throw new ValidationError(`Tier ${index + 1} needs a label`);
		if (tier.kind === 'streaming' && tier.formats?.length) {
			throw new ValidationError('The streaming tier takes no formats');
		}
		return {
			kind: tier.kind,
			label,
			...(tier.formats?.length ? { formats: tier.formats.map((f) => f.trim().toLowerCase()) } : {}),
			...(tier.minBitrateKbps ? { minBitrateKbps: tier.minBitrateKbps } : {}),
			...(tier.minBitDepth ? { minBitDepth: tier.minBitDepth } : {})
		};
	});
}

function validateSizeBounds(minSizeMb?: number | null, maxSizeMb?: number | null): void {
	for (const [name, value] of [
		['floor', minSizeMb],
		['ceiling', maxSizeMb]
	] as const) {
		if (value !== undefined && value !== null && (!Number.isFinite(value) || value <= 0)) {
			throw new ValidationError(`The size ${name} must be a positive number of MB`);
		}
	}
	if (minSizeMb && maxSizeMb && minSizeMb > maxSizeMb) {
		throw new ValidationError('The size floor cannot be above the ceiling');
	}
}

function readDefaultId(): string | null {
	const row = db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, SETTINGS_KEY))
		.get();
	if (!row?.value) return null;
	try {
		const parsed = JSON.parse(row.value) as { defaultProfileId?: string };
		return parsed.defaultProfileId ?? null;
	} catch {
		return null;
	}
}

function writeDefaultId(id: string): void {
	const value = JSON.stringify({ defaultProfileId: id });
	db.insert(settings)
		.values({ key: SETTINGS_KEY, value })
		.onConflictDoUpdate({ target: settings.key, set: { value } })
		.run();
}

/**
 * Music quality profiles are rows in `scoring_profiles` with
 * `media_kind = 'music'` — the same store, page and assignment columns the
 * video profiles use. This service only adds the music-shaped read/write.
 *
 * Resolution is album → artist → default, with nulls meaning "inherit".
 */
export class MusicProfileService {
	private rows(): Array<typeof scoringProfiles.$inferSelect> {
		return db
			.select()
			.from(scoringProfiles)
			.where(eq(scoringProfiles.mediaKind, 'music'))
			.orderBy(asc(scoringProfiles.name))
			.all();
	}

	list(): MusicProfile[] {
		const defaultId = readDefaultId();
		return this.rows().map((row) => toPublic(row, defaultId));
	}

	get(id: string): MusicProfile | undefined {
		const row = db
			.select()
			.from(scoringProfiles)
			.where(and(eq(scoringProfiles.id, id), eq(scoringProfiles.mediaKind, 'music')))
			.get();
		return row ? toPublic(row, readDefaultId()) : undefined;
	}

	getDefault(): MusicProfile | undefined {
		const defaultId = readDefaultId() ?? FALLBACK_PROFILE_ID;
		return this.get(defaultId) ?? this.list()[0];
	}

	/** The library's profile: the rung between the item's own choice and the instance default. */
	private libraryProfileId(libraryId?: string | null): string | null {
		if (!libraryId) return null;
		const row = db
			.select({ qualityProfileId: libraries.qualityProfileId })
			.from(libraries)
			.where(eq(libraries.id, libraryId))
			.get();
		return row?.qualityProfileId ?? null;
	}

	resolveForAlbum(albumId: string): MusicQualityProfile {
		const row = db
			.select({
				albumProfileId: albums.qualityProfileId,
				albumLibraryId: albums.libraryId,
				artistProfileId: artists.qualityProfileId,
				artistLibraryId: artists.libraryId
			})
			.from(albums)
			.innerJoin(artists, eq(albums.artistId, artists.id))
			.where(eq(albums.id, albumId))
			.get();

		return this.resolve(
			row?.albumProfileId,
			row?.artistProfileId,
			this.libraryProfileId(row?.albumLibraryId ?? row?.artistLibraryId)
		);
	}

	resolveForArtist(artistId: string): MusicQualityProfile {
		const row = db
			.select({
				artistProfileId: artists.qualityProfileId,
				artistLibraryId: artists.libraryId
			})
			.from(artists)
			.where(eq(artists.id, artistId))
			.get();
		return this.resolve(null, row?.artistProfileId, this.libraryProfileId(row?.artistLibraryId));
	}

	resolve(
		albumProfileId?: string | null,
		artistProfileId?: string | null,
		libraryProfileId?: string | null
	): MusicQualityProfile {
		for (const id of [albumProfileId, artistProfileId, libraryProfileId, this.getDefault()?.id]) {
			if (!id) continue;
			const profile = this.get(id);
			if (profile) return toQualityProfile(profile);
		}
		return DEFAULT_MUSIC_PROFILE;
	}

	defaultQualityProfile(): MusicQualityProfile {
		const profile = this.getDefault();
		return profile ? toQualityProfile(profile) : DEFAULT_MUSIC_PROFILE;
	}

	create(input: MusicProfileInput): MusicProfile {
		const tiers = validateTiers(input.tiers);
		const name = input.name?.trim();
		if (!name) throw new ValidationError('A music profile needs a name');
		validateSizeBounds(input.minSizeMb, input.maxSizeMb);

		const row = db
			.insert(scoringProfiles)
			.values({
				name,
				description: input.description?.trim() || null,
				mediaKind: 'music',
				musicTiers: tiers,
				musicAllowFallback: input.allowFallback ?? true,
				musicMinSizeMb: input.minSizeMb ?? null,
				musicMaxSizeMb: input.maxSizeMb ?? null,
				isBuiltIn: false,
				isDefault: false
			})
			.returning()
			.get();
		return toPublic(row, readDefaultId());
	}

	update(id: string, input: Partial<MusicProfileInput>): MusicProfile | undefined {
		const existing = this.get(id);
		if (!existing) return undefined;

		const values: Partial<typeof scoringProfiles.$inferInsert> = {
			updatedAt: new Date().toISOString()
		};
		if (input.name !== undefined) {
			const name = input.name.trim();
			if (!name) throw new ValidationError('A music profile needs a name');
			values.name = name;
		}
		if (input.description !== undefined) values.description = input.description?.trim() || null;
		if (input.tiers !== undefined) values.musicTiers = validateTiers(input.tiers);
		if (input.allowFallback !== undefined) values.musicAllowFallback = input.allowFallback;
		if (input.minSizeMb !== undefined || input.maxSizeMb !== undefined) {
			const minSizeMb = input.minSizeMb !== undefined ? input.minSizeMb : existing.minSizeMb;
			const maxSizeMb = input.maxSizeMb !== undefined ? input.maxSizeMb : existing.maxSizeMb;
			validateSizeBounds(minSizeMb, maxSizeMb);
			if (input.minSizeMb !== undefined) values.musicMinSizeMb = input.minSizeMb;
			if (input.maxSizeMb !== undefined) values.musicMaxSizeMb = input.maxSizeMb;
		}

		const row = db
			.update(scoringProfiles)
			.set(values)
			.where(and(eq(scoringProfiles.id, id), eq(scoringProfiles.mediaKind, 'music')))
			.returning()
			.get();
		return row ? toPublic(row, readDefaultId()) : undefined;
	}

	/** Deleting is for custom profiles only; assignments fall back to the default. */
	remove(id: string): boolean {
		const profile = this.get(id);
		if (!profile) return false;
		if (profile.isBuiltIn) throw new ValidationError('Built-in music profiles cannot be deleted');
		if (profile.isDefault) {
			throw new ValidationError('Choose another default before deleting this profile');
		}

		return db.transaction((tx) => {
			tx.update(albums)
				.set({ qualityProfileId: null })
				.where(eq(albums.qualityProfileId, id))
				.run();
			tx.update(artists)
				.set({ qualityProfileId: null })
				.where(eq(artists.qualityProfileId, id))
				.run();
			// A library pointing at a deleted profile would resolve to the default
			// anyway (unknown ids are skipped), but the column should not hold a
			// dangling id that the UI then shows as "inherit".
			tx.update(libraries)
				.set({ qualityProfileId: null })
				.where(eq(libraries.qualityProfileId, id))
				.run();
			const result = tx.delete(scoringProfiles).where(eq(scoringProfiles.id, id)).run();
			return result.changes > 0;
		});
	}

	setDefault(id: string): boolean {
		const profile = this.get(id);
		if (!profile) return false;
		writeDefaultId(id);
		return true;
	}

	/** The music default, used by the settings endpoint. */
	getDefaultId(): string | null {
		return this.getDefault()?.id ?? null;
	}
}

export const musicProfileService = new MusicProfileService();
