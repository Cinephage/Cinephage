import { describe, expect, it } from 'vitest';
import { libraryMediaTypeSchema, rootFolderMediaTypeSchema } from '#lib/validation/schemas.js';
import {
	DISCOVER_KIND_IDS,
	LIBRARY_KIND_IDS,
	MEDIA_KIND_IDS,
	MEDIA_KINDS,
	kind
} from './registry.js';

describe('media-kind registry', () => {
	it('pins the kind set — a new kind is a deliberate registry entry', () => {
		expect([...MEDIA_KINDS.keys()]).toEqual(['movie', 'tv', 'music']);
		expect(MEDIA_KIND_IDS).toEqual(['movie', 'tv', 'music']);
	});

	it('every kind carries labels, a root-folder name and a sub-library vocabulary', () => {
		for (const id of MEDIA_KIND_IDS) {
			const entry = kind(id);
			expect(entry.labels.singular.length).toBeGreaterThan(0);
			expect(entry.labels.plural.length).toBeGreaterThan(0);
			expect(entry.labels.rootFolder.length).toBeGreaterThan(0);
			expect(entry.subTypes.length).toBeGreaterThan(0);
		}
	});

	it('the library and root-folder schemas draw their values from the registry', () => {
		expect([...LIBRARY_KIND_IDS]).toEqual(['movie', 'tv', 'music']);
		for (const id of LIBRARY_KIND_IDS) {
			expect(libraryMediaTypeSchema.safeParse(id).success).toBe(true);
			expect(rootFolderMediaTypeSchema.safeParse(id).success).toBe(true);
		}
	});

	it('kinds outside the registry stay rejected', () => {
		expect(libraryMediaTypeSchema.safeParse('book').success).toBe(false);
		expect(rootFolderMediaTypeSchema.safeParse('book').success).toBe(false);
	});

	it('Discover serves exactly the catalog-backed kinds — music joins with its catalog source', () => {
		expect(DISCOVER_KIND_IDS).toEqual(['movie', 'tv']);
	});
});
