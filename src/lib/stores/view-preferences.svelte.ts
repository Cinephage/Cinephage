import { browser } from '$app/env';

const VIEW_MODE_KEY = 'library-view-mode';
const GROUP_BY_COLLECTION_KEY = 'library-group-by-collection';

export type ViewMode = 'grid' | 'list';

// Storage access throws in browsers that block site data (e.g. Firefox ETP /
// blocked cookies) — the store is instantiated at module scope, so every read
// and write must fail soft to defaults instead of crashing import time.
function readSession(key: string): string | null {
	try {
		return sessionStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeSession(key: string, value: string): void {
	try {
		sessionStorage.setItem(key, value);
	} catch {
		// storage unavailable — preference applies for this session only
	}
}

function getInitialViewMode(): ViewMode {
	if (browser) {
		const stored = readSession(VIEW_MODE_KEY) as ViewMode | null;
		if (stored === 'grid' || stored === 'list') {
			return stored;
		}
	}
	return 'grid';
}

function getInitialGroupByCollection(): boolean {
	if (browser) {
		return readSession(GROUP_BY_COLLECTION_KEY) === 'true';
	}
	return false;
}

class ViewPreferencesStore {
	viewMode = $state<ViewMode>(getInitialViewMode());
	groupByCollection = $state(getInitialGroupByCollection());
	/** True once the client has resolved the stored preference. Use to avoid SSR flash. */
	isReady = $state(browser);

	setViewMode(mode: ViewMode) {
		this.viewMode = mode;
		if (browser) {
			writeSession(VIEW_MODE_KEY, mode);
		}
	}

	toggleViewMode() {
		this.setViewMode(this.viewMode === 'grid' ? 'list' : 'grid');
	}

	setGroupByCollection(grouped: boolean) {
		this.groupByCollection = grouped;
		if (browser) {
			writeSession(GROUP_BY_COLLECTION_KEY, String(grouped));
		}
	}

	toggleGroupByCollection() {
		this.setGroupByCollection(!this.groupByCollection);
	}
}

export const viewPreferences = new ViewPreferencesStore();
