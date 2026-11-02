import type { RequestHandler } from './$types';
import { readdir, stat } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import {
	isManagedRootPath,
	isPathAllowed,
	isPathInsideManagedRoot
} from '#lib/server/filesystem/path-guard.js';
import { isVideoFile } from '#lib/server/library/media-info.js';

export interface DirectoryEntry {
	name: string;
	path: string;
	isDirectory: boolean;
	size?: number;
}

export interface BrowseResponse {
	currentPath: string;
	parentPath: string | null;
	entries: DirectoryEntry[];
	error?: string;
}

export const GET: RequestHandler = async ({ url }) => {
	const rawPath = url.searchParams.get('path') || homedir();
	const requestedPath = resolve(rawPath); // Normalize to prevent ../ tricks
	const includeFiles = url.searchParams.get('includeFiles') === 'true';
	const fileFilter = url.searchParams.get('fileFilter') || 'all';
	const excludeManagedRoots = url.searchParams.get('excludeManagedRoots') === 'true';

	// Validate path is within allowed boundaries
	if (!(await isPathAllowed(requestedPath))) {
		return Response.json(
			{
				currentPath: requestedPath,
				parentPath: null,
				entries: [],
				error: 'Access denied: Path is outside allowed directories'
			} satisfies BrowseResponse,
			{ status: 403 }
		);
	}

	if (excludeManagedRoots && (await isPathInsideManagedRoot(requestedPath))) {
		return Response.json(
			{
				currentPath: requestedPath,
				parentPath: dirname(requestedPath),
				entries: [],
				error: 'Managed root folders are hidden in this browser.'
			} satisfies BrowseResponse,
			{ status: 403 }
		);
	}

	try {
		const stats = await stat(requestedPath);
		if (!stats.isDirectory()) {
			return Response.json({
				currentPath: requestedPath,
				parentPath: dirname(requestedPath),
				entries: [],
				error: 'Path is not a directory'
			} satisfies BrowseResponse);
		}

		const items = await readdir(requestedPath, { withFileTypes: true });

		const directoryCandidates = await Promise.all(
			items
				.filter((item) => item.isDirectory())
				.filter((item) => !item.name.startsWith('.'))
				.map(async (item): Promise<DirectoryEntry | null> => {
					const entryPath = join(requestedPath, item.name);
					if (excludeManagedRoots && (await isManagedRootPath(entryPath))) {
						return null;
					}
					return {
						name: item.name,
						path: entryPath,
						isDirectory: true
					};
				})
		);
		const directories: DirectoryEntry[] = directoryCandidates
			.filter((entry): entry is NonNullable<(typeof directoryCandidates)[number]> => entry !== null)
			.sort((a, b) => a.name.localeCompare(b.name));

		let files: DirectoryEntry[] = [];
		if (includeFiles) {
			files = await Promise.all(
				items
					.filter((item) => item.isFile())
					.filter((item) => !item.name.startsWith('.'))
					.filter((item) =>
						fileFilter === 'video' ? isVideoFile(join(requestedPath, item.name)) : true
					)
					.map(async (item) => {
						const filePath = join(requestedPath, item.name);
						const fileStats = await stat(filePath);
						return {
							name: item.name,
							path: filePath,
							isDirectory: false,
							size: fileStats.size
						} satisfies DirectoryEntry;
					})
			);
			files.sort((a, b) => a.name.localeCompare(b.name));
		}

		const entries: DirectoryEntry[] = [...directories, ...files];

		// Only show parent path if it's within allowed boundaries
		const potentialParent = requestedPath !== '/' ? dirname(requestedPath) : null;
		const parentPath =
			potentialParent && (await isPathAllowed(potentialParent)) ? potentialParent : null;

		return Response.json({
			currentPath: requestedPath,
			parentPath,
			entries
		} satisfies BrowseResponse);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return Response.json(
			{
				currentPath: requestedPath,
				parentPath: dirname(requestedPath),
				entries: [],
				error: `Cannot access path: ${message}`
			} satisfies BrowseResponse,
			{ status: 400 }
		);
	}
};
