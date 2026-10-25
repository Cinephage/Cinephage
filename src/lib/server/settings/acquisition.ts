import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';

export type AcquisitionProtocol = 'torrent' | 'debrid';
export const DEFAULT_ACQUISITION_PROTOCOL_KEY = 'default_acquisition_protocol';

export function getDefaultAcquisitionProtocol(): AcquisitionProtocol {
	const row = db
		.select()
		.from(settings)
		.where(eq(settings.key, DEFAULT_ACQUISITION_PROTOCOL_KEY))
		.get();
	return row?.value === 'debrid' ? 'debrid' : 'torrent';
}

export function setDefaultAcquisitionProtocol(value: AcquisitionProtocol): void {
	db.insert(settings)
		.values({ key: DEFAULT_ACQUISITION_PROTOCOL_KEY, value })
		.onConflictDoUpdate({ target: settings.key, set: { value } })
		.run();
}
