/**
 * POST   /api/user/avatar — upload the caller's own avatar (multipart/form-data, field "avatar")
 * DELETE /api/user/avatar — remove the caller's own self-uploaded avatar
 */

import type { RequestHandler } from './$types.js';
import { createChildLogger } from '#lib/logging/index.js';
import {
	deleteAvatar,
	InvalidAvatarError,
	saveAvatar
} from '#lib/server/avatars/AvatarStorageService.js';

const logger = createChildLogger({ module: 'UserAvatarApi', logDomain: 'system' });

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	let formData: FormData;
	try {
		formData = await request.formData();
	} catch {
		return Response.json({ success: false, error: 'Invalid upload' }, { status: 400 });
	}

	const file = formData.get('avatar');
	if (!(file instanceof File)) {
		return Response.json({ success: false, error: 'No file provided' }, { status: 400 });
	}

	try {
		const image = await saveAvatar(locals.user.id, file);
		logger.info({ userId: locals.user.id }, '[UserAvatar] Uploaded avatar');
		return Response.json({ success: true, image });
	} catch (error) {
		if (error instanceof InvalidAvatarError) {
			return Response.json({ success: false, error: error.message }, { status: 400 });
		}
		logger.error({ err: error, userId: locals.user.id }, '[UserAvatar] Failed to save avatar');
		return Response.json({ success: false, error: 'Failed to save avatar' }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	try {
		await deleteAvatar(locals.user.id);
		logger.info({ userId: locals.user.id }, '[UserAvatar] Removed avatar');
		return Response.json({ success: true });
	} catch (error) {
		logger.error({ err: error, userId: locals.user.id }, '[UserAvatar] Failed to remove avatar');
		return Response.json({ success: false, error: 'Failed to remove avatar' }, { status: 500 });
	}
};
