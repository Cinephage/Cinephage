import { SvelteSet } from 'svelte/reactivity';
import type {
	UnmatchedFile,
	UnmatchedFolder,
	UnmatchedFilters,
	PaginationState,
	ViewMode
} from '#lib/types/unmatched.js';

interface UnmatchedState {
	files: UnmatchedFile[];
	folders: UnmatchedFolder[];
	filters: UnmatchedFilters;
	pagination: PaginationState;
	viewMode: ViewMode;
	selectedFiles: SvelteSet<string>;
	loading: boolean;
	error: string | null;
}

const STORAGE_KEY_VIEW_MODE = 'unmatched:viewMode';
const STORAGE_KEY_MEDIA_TYPE = 'unmatched:mediaType';

function readViewMode(): 'list' | 'folder' {
	try {
		const v = localStorage.getItem(STORAGE_KEY_VIEW_MODE);
		return v === 'folder' ? 'folder' : 'list';
	} catch {
		return 'list';
	}
}

function readMediaType(): 'movie' | 'tv' | undefined {
	try {
		const v = localStorage.getItem(STORAGE_KEY_MEDIA_TYPE);
		return v === 'movie' || v === 'tv' ? v : undefined;
	} catch {
		return undefined;
	}
}

class UnmatchedFilesStore {
	private state = $state<UnmatchedState>({
		files: [],
		folders: [],
		filters: { mediaType: readMediaType() },
		pagination: {
			page: 1,
			limit: 50,
			total: 0,
			totalPages: 1
		},
		viewMode: readViewMode(),
		selectedFiles: new SvelteSet(),
		loading: false,
		error: null
	});

	// Getters
	get files() {
		return this.state.files;
	}
	get folders() {
		return this.state.folders;
	}
	get filters() {
		return this.state.filters;
	}
	get pagination() {
		return this.state.pagination;
	}
	get viewMode() {
		return this.state.viewMode;
	}
	get selectedFiles() {
		return this.state.selectedFiles;
	}
	get loading() {
		return this.state.loading;
	}
	get error() {
		return this.state.error;
	}

	// Derived values
	get selectedCount() {
		return this.state.selectedFiles.size;
	}

	get hasSelection() {
		return this.state.selectedFiles.size > 0;
	}

	get filteredFiles() {
		if (this.state.filters.mediaType) {
			return this.state.files.filter((f) => f.mediaType === this.state.filters.mediaType);
		}
		return this.state.files;
	}

	get filteredFolders() {
		if (this.state.filters.mediaType) {
			return this.state.folders.filter((f) => f.mediaType === this.state.filters.mediaType);
		}
		return this.state.folders;
	}

	// Actions
	async loadFiles() {
		this.state.loading = true;
		this.state.error = null;

		try {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity
			const params = new URLSearchParams();
			params.set('page', String(this.state.pagination.page));
			params.set('limit', String(this.state.pagination.limit));

			if (this.state.filters.mediaType) {
				params.set('mediaType', this.state.filters.mediaType);
			}

			if (this.state.filters.search) {
				params.set('search', this.state.filters.search);
			}

			// If in folder view, get folders instead
			if (this.state.viewMode === 'folder') {
				params.set('groupBy', 'show');
				const response = await fetch(`/api/library/unmatched?${params}`);
				const result = await response.json();

				if (result.success) {
					this.state.folders = result.data.folders;
					this.state.pagination.total = result.data.totalFiles;
					this.state.pagination.totalPages = Math.ceil(
						result.data.totalFiles / this.state.pagination.limit
					);
				} else {
					this.state.error = result.error || 'Failed to load folders';
				}
			} else {
				const response = await fetch(`/api/library/unmatched?${params}`);
				const result = await response.json();

				if (result.success) {
					this.state.files = result.data.files;
					this.state.pagination.total = result.data.pagination.total;
					this.state.pagination.totalPages = result.data.pagination.totalPages;
					this.state.pagination.page = result.data.pagination.page;
					this.state.pagination.limit = result.data.pagination.limit;
				} else {
					this.state.error = result.error || 'Failed to load files';
				}
			}
		} catch (err) {
			this.state.error = err instanceof Error ? err.message : 'Failed to load data';
		} finally {
			this.state.loading = false;
		}
	}

	setPage(page: number) {
		this.state.pagination.page = page;
		this.loadFiles();
	}

	setLimit(limit: number) {
		this.state.pagination.limit = limit;
		this.state.pagination.page = 1;
		this.loadFiles();
	}

	setFilter(key: keyof UnmatchedFilters, value: string | undefined) {
		// Clear stale data immediately so UI doesn't show filtered-out items
		this.state.folders = [];
		this.state.files = [];

		if (value) {
			(this.state.filters as Record<string, string | undefined>)[key] = value;
		} else {
			delete this.state.filters[key];
		}

		if (key === 'mediaType') {
			try {
				if (value) {
					localStorage.setItem(STORAGE_KEY_MEDIA_TYPE, value);
				} else {
					localStorage.removeItem(STORAGE_KEY_MEDIA_TYPE);
				}
			} catch {
				/* ignore */
			}
		}

		this.state.pagination.page = 1;
		this.loadFiles();
	}

	setViewMode(mode: ViewMode) {
		this.state.viewMode = mode;
		this.state.selectedFiles.clear();
		try {
			localStorage.setItem(STORAGE_KEY_VIEW_MODE, mode);
		} catch {
			/* ignore */
		}
		this.loadFiles();
	}

	toggleFileSelection(fileId: string) {
		if (this.state.selectedFiles.has(fileId)) {
			this.state.selectedFiles.delete(fileId);
		} else {
			this.state.selectedFiles.add(fileId);
		}
	}

	selectAllFiles() {
		const files =
			this.state.viewMode === 'folder'
				? this.state.folders.flatMap((f) => f.files)
				: this.state.files;

		files.forEach((f) => this.state.selectedFiles.add(f.id));
	}

	clearSelection() {
		this.state.selectedFiles.clear();
	}

	async deleteFiles(fileIds: string[], deleteFromDisk: boolean = false) {
		try {
			const response = await fetch('/api/library/unmatched', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ fileIds, deleteFromDisk })
			});

			const result = await response.json();

			if (result.success) {
				// Remove from local state
				fileIds.forEach((id) => {
					this.state.selectedFiles.delete(id);
					this.state.files = this.state.files.filter((f) => f.id !== id);
				});
				this.state.pagination.total = Math.max(0, this.state.pagination.total - fileIds.length);
				return result.data;
			} else {
				throw new Error(result.error || 'Failed to delete files');
			}
		} catch (err) {
			this.state.error = err instanceof Error ? err.message : 'Failed to delete files';
			throw err;
		}
	}

	async matchFiles(
		fileIds: string[],
		tmdbId: number,
		mediaType: 'movie' | 'tv',
		options?: {
			season?: number;
			episodeMapping?: Record<string, { season: number; episode: number }>;
		}
	) {
		try {
			const response = await fetch('/api/library/unmatched/match', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					fileIds,
					tmdbId,
					mediaType,
					...options
				})
			});

			const result = await response.json();

			if (result.success) {
				// Remove matched files from state
				fileIds.forEach((id) => {
					this.state.selectedFiles.delete(id);
					this.state.files = this.state.files.filter((f) => f.id !== id);
				});
				this.state.pagination.total = Math.max(0, this.state.pagination.total - fileIds.length);
				return result.data;
			} else {
				throw new Error(result.error || 'Failed to match files');
			}
		} catch (err) {
			this.state.error = err instanceof Error ? err.message : 'Failed to match files';
			throw err;
		}
	}

	async processAll() {
		this.state.loading = true;
		try {
			const response = await fetch('/api/library/unmatched', { method: 'POST' });
			const result = await response.json();

			if (result.success) {
				// The work is queued as background jobs; matching happens over the
				// next minutes. Reload once so rows reflect any immediate changes,
				// then hand the queue info back to the caller for display.
				await this.loadFiles();
				return result.data;
			} else {
				throw new Error(result.error || 'Failed to process files');
			}
		} catch (err) {
			this.state.error = err instanceof Error ? err.message : 'Failed to process files';
			throw err;
		} finally {
			this.state.loading = false;
		}
	}
}

export const unmatchedFilesStore = new UnmatchedFilesStore();
