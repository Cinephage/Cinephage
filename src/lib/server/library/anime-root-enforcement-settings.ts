import { db } from '#lib/server/db/index.js';
import { rootFolders, settings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

export const ANIME_ROOT_FOLDER_ENFORCEMENT_KEY = 'enforce_anime_root_folder';

export async function isAnimeRootFolderEnforcementEnabled(): Promise<boolean> {
	const row = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, ANIME_ROOT_FOLDER_ENFORCEMENT_KEY))
		.get();

	return row?.value === 'true';
}

export async function setAnimeRootFolderEnforcement(enabled: boolean): Promise<void> {
	await db
		.insert(settings)
		.values({
			key: ANIME_ROOT_FOLDER_ENFORCEMENT_KEY,
			value: enabled ? 'true' : 'false'
		})
		.onConflictDoUpdate({
			target: settings.key,
			set: { value: enabled ? 'true' : 'false' }
		});
}

export async function getEffectiveAnimeRootFolderEnforcement(): Promise<boolean> {
	const [enabled, hasAnimeSubtypeFolder] = await Promise.all([
		isAnimeRootFolderEnforcementEnabled(),
		db
			.select({ id: rootFolders.id })
			.from(rootFolders)
			.where(eq(rootFolders.mediaSubType, 'anime'))
			.limit(1)
			.then((rows) => rows.length > 0)
	]);

	if (enabled && !hasAnimeSubtypeFolder) {
		await setAnimeRootFolderEnforcement(false);
		return false;
	}

	return enabled;
}
