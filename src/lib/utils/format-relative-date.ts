import * as m from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';

export function formatRelativeDate(dateStr: string): { display: string; full: string } {
	const date = new Date(dateStr);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

	const full = date.toLocaleDateString(getLocale());

	if (diffDays === 0) return { display: m.library_libraryMediaTable_today(), full };
	if (diffDays === 1) return { display: m.library_libraryMediaTable_yesterday(), full };
	if (diffDays < 7)
		return { display: m.library_libraryMediaTable_daysAgo({ count: diffDays }), full };

	const weeks = Math.floor(diffDays / 7);
	if (diffDays < 30)
		return { display: m.library_libraryMediaTable_weeksAgo({ count: weeks }), full };

	const months = Math.floor(diffDays / 30);
	if (diffDays < 365)
		return { display: m.library_libraryMediaTable_monthsAgo({ count: months }), full };

	return { display: full, full };
}
