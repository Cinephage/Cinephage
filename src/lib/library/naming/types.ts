/**
 * Shared naming/rename types
 *
 * Lives outside #lib/server so it can be imported from .svelte files
 * without leaking server code into the client bundle. The server's
 * RenamePreviewService imports these types from here.
 */

export type RenameStatus = 'will_change' | 'already_correct' | 'collision' | 'error';

/**
 * A single file's rename preview
 */
export interface RenamePreviewItem {
	fileId: string;
	mediaType: 'movie' | 'episode';
	mediaId: string;
	mediaTitle: string;

	// Current paths
	currentParentPath: string;
	currentRelativePath: string;
	currentFullPath: string;

	// New paths (what it would be renamed to)
	newParentPath: string;
	newRelativePath: string;
	newFullPath: string;

	// Status
	status: RenameStatus;
	collisionsWith?: string[]; // fileIds that would collide
	error?: string;
}

/**
 * Result of a rename preview operation
 */
export interface RenamePreviewResult {
	willChange: RenamePreviewItem[];
	alreadyCorrect: RenamePreviewItem[];
	collisions: RenamePreviewItem[];
	errors: RenamePreviewItem[];

	// Summary stats
	totalFiles: number;
	totalWillChange: number;
	totalAlreadyCorrect: number;
	totalCollisions: number;
	totalErrors: number;

	// Set when the movie folder template uses {Collection} but this movie
	// has no collection data — paths will be wrong until metadata is refreshed.
	missingCollectionData?: boolean;
}

/**
 * Result of executing renames
 */
export interface RenameExecuteResult {
	success: boolean;
	processed: number;
	succeeded: number;
	failed: number;
	results: Array<{
		fileId: string;
		mediaType: 'movie' | 'episode';
		success: boolean;
		oldPath: string;
		newPath: string;
		error?: string;
	}>;
	warnings?: string[];
}

/**
 * NDJSON stream events emitted by GET /api/rename/preview
 */
export type RenameStreamEvent =
	| { type: 'start'; totalFiles: number; computing: boolean }
	| {
			type: 'items';
			category: 'willChange' | 'alreadyCorrect' | 'errors' | 'collisions';
			data: RenamePreviewItem[];
	  }
	| {
			type: 'done';
			totalFiles: number;
			totalWillChange: number;
			totalAlreadyCorrect: number;
			totalCollisions: number;
			totalErrors: number;
	  }
	| { type: 'error'; message: string };

/**
 * A single item in a batched reorganize request
 */
export interface ReorganizeRequestItem {
	mediaId: string;
	mediaType: 'movie' | 'series';
}

/**
 * Result of a batched reorganize operation
 */
export interface ReorganizeBatchResult {
	success: boolean;
	organized: number;
	failed: number;
	results: Array<{
		mediaId: string;
		mediaType: 'movie' | 'series';
		success: boolean;
		error?: string;
	}>;
}
