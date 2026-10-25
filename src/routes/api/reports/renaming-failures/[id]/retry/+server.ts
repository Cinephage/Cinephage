import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { renamingFailures, movieFiles, episodeFiles } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { rename, mkdir, access } from 'fs/promises';
import { dirname, basename } from 'path';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdminLocals } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'ReportsRenamingFailuresRetry', logDomain: 'scans' });

const NON_RETRYABLE = new Set(['source_not_found', 'path_too_long', 'invalid_chars']);

export const POST: RequestHandler = async ({ params, locals }) => {
	// Defense-in-depth: the hooks viewer gate confines this route; this
	// guard keeps it admin-only even if the gate is ever refactored.
	const authError = requireAdminLocals(locals);
	if (authError) return authError;

	const { id } = params;

	const failure = await db.select().from(renamingFailures).where(eq(renamingFailures.id, id)).get();

	if (!failure) throw error(404, 'Renaming failure record not found');
	if (failure.status === 'resolved') {
		return Response.json({ success: false, error: 'Record is already resolved' }, { status: 400 });
	}
	if (NON_RETRYABLE.has(failure.reason)) {
		return Response.json(
			{ success: false, error: `Cannot retry: reason '${failure.reason}' requires a manual fix` },
			{ status: 422 }
		);
	}

	// Verify source exists
	try {
		await access(failure.sourcePath);
	} catch {
		return Response.json(
			{ success: false, error: 'Source file no longer exists — cannot retry' },
			{ status: 422 }
		);
	}

	// For collisions, check the target is now free
	if (failure.reason === 'collision') {
		try {
			await access(failure.intendedPath);
			return Response.json(
				{
					success: false,
					error:
						'Target path is still occupied by another file. Resolve the collision before retrying.'
				},
				{ status: 409 }
			);
		} catch {
			// Not accessible = free, proceed
		}
	}

	// Ensure target directory exists
	try {
		await mkdir(dirname(failure.intendedPath), { recursive: true });
	} catch {
		// Directory may already exist
	}

	// Attempt the rename
	try {
		await rename(failure.sourcePath, failure.intendedPath);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Rename failed';
		logger.warn({ err, id }, '[Reports] Renaming retry failed at fs.rename');
		return Response.json({ success: false, error: message }, { status: 500 });
	}

	// Update the library file record to reflect the new path
	const newRelativePath = basename(failure.intendedPath);
	try {
		if (failure.fileType === 'movie') {
			await db
				.update(movieFiles)
				.set({ relativePath: newRelativePath })
				.where(eq(movieFiles.id, failure.fileId));
		} else {
			await db
				.update(episodeFiles)
				.set({ relativePath: newRelativePath })
				.where(eq(episodeFiles.id, failure.fileId));
		}
	} catch (err) {
		// File was renamed on disk — log but don't fail the response; the library
		// scanner will reconcile the path on next scan.
		logger.warn({ err, id }, '[Reports] Renamed on disk but failed to update library record');
	}

	await db
		.update(renamingFailures)
		.set({ status: 'resolved', resolvedAt: new Date().toISOString() })
		.where(eq(renamingFailures.id, id));

	logger.info(
		{ id, from: failure.sourcePath, to: failure.intendedPath },
		'[Reports] Renaming retry succeeded'
	);
	return Response.json({ success: true, message: 'File renamed successfully' });
};
