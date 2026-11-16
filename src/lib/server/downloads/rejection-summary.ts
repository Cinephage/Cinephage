/**
 * Human-readable summary of a search that accepted nothing.
 *
 * Automatic searches walk a ranked list of candidates. Reporting only the last
 * refusal makes one candidate's reason read as the whole story - a movie set to
 * 1080p showed "Resolution 2160p is outside the movie's desired qualities"
 * while the real reason nothing was grabbed was that every 1080p candidate had
 * already been imported. Callers collect the rejection types they saw and hand
 * them here once the list is exhausted.
 */
export function summarizeRejections(
	rejections: readonly string[],
	fallback?: string
): string | undefined {
	if (rejections.length === 0) return fallback;

	const counts = new Map<string, number>();
	for (const reason of rejections) counts.set(reason, (counts.get(reason) ?? 0) + 1);
	const breakdown = [...counts.entries()]
		.map(([reason, count]) => `${count} x ${reason}`)
		.join(', ');

	return `No acceptable release: ${rejections.length} rejected (${breakdown})`;
}
