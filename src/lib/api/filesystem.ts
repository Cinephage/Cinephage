import { apiGet } from './client.js';

/** Client-safe mirror of the browse payload. Source of truth:
 * src/routes/api/filesystem/browse/+server.ts (BrowseResponse). */
export interface BrowseEntry {
	name: string;
	path: string;
	isDirectory: boolean;
	size?: number;
}

export interface BrowseResponse {
	currentPath: string;
	parentPath: string | null;
	entries: BrowseEntry[];
	error?: string;
}

export async function browseFilesystem(
	path?: string,
	opts?: { includeFiles?: boolean; fileFilter?: string; excludeManagedRoots?: boolean }
): Promise<BrowseResponse> {
	const params: Record<string, string> = {};
	if (path) params.path = path;
	if (opts?.includeFiles) params.includeFiles = 'true';
	if (opts?.fileFilter) params.fileFilter = opts.fileFilter;
	if (opts?.excludeManagedRoots) params.excludeManagedRoots = 'true';
	// The endpoint returns the browse payload without the success envelope.
	const response = await apiGet('/api/filesystem/browse', params);
	return response as unknown as BrowseResponse;
}
