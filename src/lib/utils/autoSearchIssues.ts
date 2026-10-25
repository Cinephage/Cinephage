import type { SearchResults } from '#lib/stores/searchProgress.svelte.js';

export function getPrimaryAutoSearchIssue(
	results: SearchResults | null | undefined
): { message: string; description?: string } | null {
	if (!results) return null;

	const issue = results.issues?.[0];
	if (issue) {
		return {
			message: issue.message,
			description: issue.suggestion
		};
	}

	if (results.error) {
		return { message: results.error };
	}

	return null;
}
