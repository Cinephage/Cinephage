export function extractSearchYear(query: string): { title: string; year?: number } {
	const title = query.trim();
	const match = title.match(/^(.+?)\s*(?:\(((?:19|20)\d{2})(?:[- ][^)]*)?\)|\s+((?:19|20)\d{2}))$/);
	if (!match) return { title };

	const year = Number(match[2] ?? match[3]);
	if (year > new Date().getFullYear() + 2) return { title };
	return { title: match[1].trim(), year };
}
