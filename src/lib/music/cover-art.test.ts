import { describe, expect, it } from 'vitest';
import {
	isCoverKind,
	isCoverMbid,
	isCoverSize,
	releaseCoverUrl,
	releaseGroupCoverUrl
} from './cover-art.js';

const GROUP = '48117b90-a16e-34ca-a514-19c702df1158';
const RELEASE = 'ab5ca495-8983-41b9-86b4-46a981d173be';

describe('cover art urls', () => {
	it('builds the local endpoint the grid and the detail pages ask for', () => {
		expect(releaseGroupCoverUrl(GROUP)).toBe(`/api/music/cover/release-group/${GROUP}/250`);
		expect(releaseGroupCoverUrl(GROUP, 500)).toBe(`/api/music/cover/release-group/${GROUP}/500`);
		expect(releaseCoverUrl(RELEASE)).toBe(`/api/music/cover/release/${RELEASE}/500`);
	});

	it('accepts only the sizes the archive publishes', () => {
		expect(isCoverSize(250)).toBe(true);
		expect(isCoverSize('1200')).toBe(true);
		expect(isCoverSize(300)).toBe(false);
		expect(isCoverSize('large')).toBe(false);
	});

	it('accepts only the two archive kinds', () => {
		expect(isCoverKind('release')).toBe(true);
		expect(isCoverKind('release-group')).toBe(true);
		expect(isCoverKind('artist')).toBe(false);
	});

	it('accepts only MusicBrainz ids, so no id can rewrite the archive path', () => {
		expect(isCoverMbid(GROUP)).toBe(true);
		expect(isCoverMbid('../../etc/passwd')).toBe(false);
		expect(isCoverMbid('48117b90-a16e-34ca-a514')).toBe(false);
	});
});
