import { getLocale } from '#lib/paraglide/runtime.js';

/**
 * Format a number as USD currency
 */
export function formatCurrency(amount: number, locale = 'en-US'): string {
	if (amount <= 0) return '';
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: 'USD',
		maximumFractionDigits: 0,
		notation: amount >= 1_000_000_000 ? 'compact' : 'standard'
	}).format(amount);
}

/**
 * Format a Date object to YYYY-MM-DD using local date components.
 * Use this instead of toISOString().split('T')[0] to avoid UTC timezone shifts.
 */
export function toDateString(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Get today's date as YYYY-MM-DD in local time.
 */
export function todayDateString(): string {
	return toDateString(new Date());
}

/**
 * Format a date string or Date for display using the current Paraglide locale.
 * This is the primary display-date function — use it instead of raw toLocaleDateString().
 */
export function formatDisplayDate(
	dateStr: string | Date | null | undefined,
	options?: Intl.DateTimeFormatOptions
): string {
	if (!dateStr) return '';
	return new Intl.DateTimeFormat(getLocale(), {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		...options
	}).format(new Date(dateStr));
}

/**
 * Format a date string for display using short month names (e.g. "Jun 17, 2026").
 */
export function formatDisplayDateShort(dateStr: string | null | undefined): string {
	return formatDisplayDate(dateStr, { month: 'short' });
}

/**
 * Format a date string to readable long format (e.g. "June 17, 2026").
 * Prefer formatDisplayDate() for user-facing dates.
 */
export function formatDate(dateString: string, locale: string): string {
	if (!dateString) return '';
	return new Intl.DateTimeFormat(locale, {
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	}).format(new Date(dateString));
}

/**
 * Format a date string to short format (e.g. "Jun 17, 2026").
 * Prefer formatDisplayDateShort() for user-facing dates.
 */
export function formatDateShort(dateString: string, locale: string): string {
	if (!dateString) return '';
	return new Intl.DateTimeFormat(locale, {
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	}).format(new Date(dateString));
}

/**
 * Get display name for a language code (ISO 639-1)
 */
export function formatLanguage(code: string, locale = 'en-US'): string {
	if (!code) return '';
	try {
		return new Intl.DisplayNames([locale], { type: 'language' }).of(code) || code;
	} catch {
		return code;
	}
}

/**
 * Get display name for a country code (ISO 3166-1)
 */
export function formatCountry(code: string, locale = 'en-US'): string {
	if (!code) return '';
	try {
		return new Intl.DisplayNames([locale], { type: 'region' }).of(code) || code;
	} catch {
		return code;
	}
}

/**
 * Format bytes to human-readable string (e.g., "1.5 GB").
 * Returns "0 B" for 0; returns "-" only for null/undefined (missing data).
 */
export function formatBytes(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined) return '-';
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Format milliseconds to human-readable duration (e.g., "2d 3h 15m" or "30s")
 * Shows days/hours/minutes for longer durations, seconds for shorter.
 */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const totalMinutes = Math.floor(totalSeconds / 60);
	const totalHours = Math.floor(totalMinutes / 60);
	const totalDays = Math.floor(totalHours / 24);

	const minutes = totalMinutes % 60;
	const hours = totalHours % 24;

	if (totalDays > 0) {
		return hours > 0 ? `${totalDays}d ${hours}h` : `${totalDays}d`;
	}
	if (totalHours > 0) {
		return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
	}
	if (totalMinutes > 0) {
		return `${totalMinutes}m`;
	}
	return `${totalSeconds}s`;
}

/**
 * Format a date range to duration string (e.g., "2h 15m" or "45s")
 */
export function formatDateRange(start: Date, end: Date): string {
	const diffMs = end.getTime() - start.getTime();
	if (diffMs < 0) return '0s';

	const totalSeconds = Math.floor(diffMs / 1000);
	const totalMinutes = Math.floor(totalSeconds / 60);
	const totalHours = Math.floor(totalMinutes / 60);

	const minutes = totalMinutes % 60;
	const seconds = totalSeconds % 60;

	if (totalHours > 0) {
		return `${totalHours}h ${minutes}m`;
	}
	if (totalMinutes > 0) {
		return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
	}
	return `${totalSeconds}s`;
}

/**
 * Extract filename from a path (e.g., "/movies/foo/bar.mp4" → "bar.mp4")
 */
export function getFileName(path: string): string {
	const parts = path.split('/');
	return parts[parts.length - 1] ?? path;
}

/**
 * Get badge variant class for series status
 */
export function getStatusColor(status: string | null): string {
	if (!status) return 'badge-ghost';
	const s = status.toLowerCase();
	if (s.includes('returning') || s.includes('production')) return 'badge-success';
	if (s.includes('ended')) return 'badge-error';
	if (s.includes('canceled')) return 'badge-warning';
	return 'badge-ghost';
}
