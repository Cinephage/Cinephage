import { describe, expect, it } from 'vitest';
import { manualImportSchema } from './schemas.js';

const base = {
	mediaType: 'movie' as const,
	tmdbId: 389,
	importTarget: 'new' as const,
	sourcePath: '/tmp/source.mkv'
};

describe('manualImportSchema preferHardlink (#584)', () => {
	it('passes an explicit per-import override through', () => {
		expect(manualImportSchema.parse({ ...base, preferHardlink: false })).toMatchObject({
			preferHardlink: false
		});
		expect(manualImportSchema.parse({ ...base, preferHardlink: true })).toMatchObject({
			preferHardlink: true
		});
	});

	it('leaves preferHardlink undefined when omitted so the global setting applies', () => {
		// The schema must NOT default this field: an omitted value means
		// "resolve from File Management at execution time", while a concrete
		// value pins the behavior at submit time for durable jobs.
		const parsed = manualImportSchema.parse(base);
		expect(parsed.preferHardlink).toBeUndefined();
	});
});
