/**
 * MusicBrainz answers one request per second, so a music page costs a second
 * per lookup it needs. The payloads here are stable for minutes at a time, and
 * the back button lands on them constantly, so the pages remember what they
 * built: first visit pays the gate, every return is free.
 */

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 200;

const store = new Map<string, { at: number; value: unknown }>();

export async function cachedByKey<T>(key: string, load: () => Promise<T>): Promise<T> {
	const hit = store.get(key);
	if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;

	const value = await load();
	if (store.size >= MAX_ENTRIES) {
		const oldest = store.keys().next().value;
		if (oldest !== undefined) store.delete(oldest);
	}
	store.set(key, { at: Date.now(), value });
	return value;
}
