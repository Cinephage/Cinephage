/**
 * A playlist could not be read. `status` is the HTTP answer the route should
 * give: 400 for a URL we do not understand or a private/empty playlist, 502
 * for a provider that failed us.
 */
export class PlaylistError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404 | 422 | 502 = 422
	) {
		super(message);
		this.name = 'PlaylistError';
	}
}
