import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { user } from '#lib/server/db/schema.js';
import { AVATAR_ALLOWED_TYPES, AVATAR_DIR, AVATAR_MAX_BYTES } from './constants.js';

export class InvalidAvatarError extends Error {}

async function removeExistingAvatarFiles(userId: string): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(AVATAR_DIR);
	} catch {
		return;
	}

	await Promise.all(
		entries
			.filter((entry) => entry.startsWith(`${userId}.`))
			.map((entry) => rm(join(AVATAR_DIR, entry), { force: true }))
	);
}

export async function saveAvatar(userId: string, file: File): Promise<string> {
	const ext = AVATAR_ALLOWED_TYPES[file.type];
	if (!ext) {
		throw new InvalidAvatarError('Unsupported image type');
	}
	if (file.size > AVATAR_MAX_BYTES) {
		throw new InvalidAvatarError('Image is too large');
	}

	await mkdir(AVATAR_DIR, { recursive: true });
	await removeExistingAvatarFiles(userId);

	const buffer = Buffer.from(await file.arrayBuffer());
	await writeFile(join(AVATAR_DIR, `${userId}.${ext}`), buffer);

	const imageUrl = `/api/user/avatar/${userId}`;
	await db.update(user).set({ image: imageUrl }).where(eq(user.id, userId));

	return imageUrl;
}

export async function deleteAvatar(userId: string): Promise<void> {
	await removeExistingAvatarFiles(userId);
	await db.update(user).set({ image: null }).where(eq(user.id, userId));
}
