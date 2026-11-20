import { and, asc, eq, ne } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import {
	albums,
	artists,
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
	isDefault: boolean;
	isBuiltIn: boolean;
	sortOrder: number;
}

export interface MusicProfileInput {
	name: string;
	description?: string | null;
	tiers: MusicProfileTierRow[];
	allowFallback?: boolean;
}

function toPublic(row: typeof scoringProfiles.$inferSelect, defaultId: string | null): MusicProfile {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		tiers: row.musicTiers ?? [],
		allowFallback: row.upgradesAllowed ?? true,
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
		tiers: row.tiers.map(
			(tier): MusicTier => ({
				kind: tier.kind,
				label: tier.label,
				formats: tier.formats as MusicFormat[] | undefined,
				minBitrateKbps: tier.minBitrateKbps,
				minBitDepth: tier.minBitDepth
			})
		),
		allowFallback: row.allowFallback,
		formatScores: {},
		minSizeMb: null,
		maxSizeMb: null
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

	resolveForAlbum(albumId: string): MusicQualityProfile {
		const row = db
			.select({
				albumProfileId: albums.qualityProfileId,
				artistProfileId: artists.qualityProfileId
			})
			.from(albums)
			.innerJoin(artists, eq(albums.artistId, artists.id))
			.where(eq(albums.id, albumId))
			.get();

		return this.resolve(row?.albumProfileId, row?.artistProfileId);
	}

	resolveForArtist(artistId: string): MusicQualityProfile {
		const row = db
			.select({ artistProfileId: artists.qualityProfileId })
			.from(artists)
			.where(eq(artists.id, artistId))
			.get();
		return this.resolve(null, row?.artistProfileId);
	}

	resolve(albumProfileId?: string | null, artistProfileId?: string | null): MusicQualityProfile {
		for (const id of [albumProfileId, artistProfileId, this.getDefault()?.id]) {
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

		const row = db
			.insert(scoringProfiles)
			.values({
				name,
				description: input.description?.trim() || null,
				mediaKind: 'music',
				musicTiers: tiers,
				upgradesAllowed: input.allowFallback ?? true,
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
		if (input.allowFallback !== undefined) values.upgradesAllowed = input.allowFallback;

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
			tx.update(albums).set({ qualityProfileId: null }).where(eq(albums.qualityProfileId, id)).run();
			tx.update(artists)
				.set({ qualityProfileId: null })
				.where(eq(artists.qualityProfileId, id))
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
