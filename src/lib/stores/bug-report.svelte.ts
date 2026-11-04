/**
 * Bug-report modal store.
 *
 * Entry points (sidebar bug icon, error page) open the report form through
 * this store; the root layout mounts the single modal instance. Opening with
 * a supportId pre-fills the Error ID field from the error page.
 */

import { browser } from '$app/env';

interface BugReportState {
	open: boolean;
	supportId: string | null;
}

function createBugReportStore() {
	const state = $state<BugReportState>({ open: false, supportId: null });

	function openReport(options?: { supportId?: string | null }): void {
		if (!browser) return;
		state.supportId = options?.supportId ?? null;
		state.open = true;
	}

	function close(): void {
		state.open = false;
	}

	return {
		get open() {
			return state.open;
		},
		get supportId() {
			return state.supportId;
		},
		openReport,
		close
	};
}

export const bugReport = createBugReportStore();
