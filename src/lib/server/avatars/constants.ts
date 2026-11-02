import { join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR || 'data';

export const AVATAR_DIR = join(DATA_DIR, 'avatars');
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_ALLOWED_TYPES: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp'
};
