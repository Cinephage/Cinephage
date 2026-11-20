/**
 * One place for how a music folder or file segment is named.
 *
 * The importer and the shortcut writer must agree byte for byte: a stream
 * album that is later downloaded has to land in the same folder the `.strm`
 * files were written to, or the library ends up with two copies of the record.
 */

/** Path-safe segment: no separators, no leading dots, no trailing spaces. */
export function sanitizeMusicSegment(value: string): string {
	const cleaned = value
		.replace(/[/\\]/g, '-')
		.replace(/[\u0000-\u001f]/g, '')
		.replace(/^\.+/, '')
		.trim()
		.replace(/[. ]+$/, '');
	return cleaned || 'Unknown';
}

/** `Discovery (2001)` — the album folder's leaf name. */
export function albumFolderName(title: string, year: number | null | undefined): string {
	return sanitizeMusicSegment(`${title}${year ? ` (${year})` : ''}`);
}
