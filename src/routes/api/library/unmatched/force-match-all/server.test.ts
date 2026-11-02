import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../test/db-helper';
import { callHandler } from '../../../../../test/api-helper';
import { randomUUID } from 'node:crypto';
import { unmatchedFiles } from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

const mockAcceptMatch = vi.fn().mockResolvedValue(undefined);

vi.mock('#lib/server/library/media-matcher.js', () => ({
	mediaMatcherService: {
		acceptMatch: mockAcceptMatch
	}
}));

vi.mock('#lib/server/auth/authorization.js', () => ({
	requireAdmin: vi.fn().mockReturnValue(null)
}));

const { POST } = await import('./+server');

function postForceMatch(body: Record<string, unknown> = {}) {
	return callHandler(POST, 'POST', body, {
		url: 'http://localhost/api/library/unmatched/force-match-all',
		auth: 'admin'
	});
}

function makeUnmatched(
	path: string,
	reason: string,
	suggestedMatches: Array<{ tmdbId: number; title: string; confidence: number }> | null = null
) {
	return {
		id: randomUUID(),
		path,
		mediaType: 'movie' as const,
		reason,
		discoveredAt: new Date().toISOString(),
		suggestedMatches
	};
}

describe('Force Match All API', () => {
	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(() => {
		clearTestDb(testDb);
		mockAcceptMatch.mockClear();
		mockAcceptMatch.mockResolvedValue(undefined);
	});

	it('returns { matched: 0, failed: 0, eligible: 0 } when no eligible files', async () => {
		const { status, data } = await postForceMatch();
		expect(status).toBe(200);
		expect((data as any).success).toBe(true);
		expect((data as any).data).toEqual({ matched: 0, failed: 0, eligible: 0 });
	});

	it('excludes ambiguous reason — only multiple_matches is eligible', async () => {
		testDb.db
			.insert(unmatchedFiles)
			.values([
				makeUnmatched('/ambiguous.mkv', 'ambiguous', [
					{ tmdbId: 100, title: 'Movie A', confidence: 0.95 }
				]),
				makeUnmatched('/multiple.mkv', 'multiple_matches', [
					{ tmdbId: 200, title: 'Movie B', confidence: 0.95 }
				])
			])
			.run();

		const { data } = await postForceMatch();
		expect((data as any).data.eligible).toBe(1);
		expect((data as any).data.matched).toBe(1);
	});

	it('excludes files whose top candidate is below default minScore (0.9)', async () => {
		testDb.db
			.insert(unmatchedFiles)
			.values(
				makeUnmatched('/low.mkv', 'multiple_matches', [
					{ tmdbId: 300, title: 'Low Confidence', confidence: 0.8 }
				])
			)
			.run();

		const { data } = await postForceMatch();
		expect((data as any).data.eligible).toBe(0);
		expect((data as any).data.matched).toBe(0);
	});

	it('custom minScore=0.5 includes lower-confidence matches', async () => {
		testDb.db
			.insert(unmatchedFiles)
			.values(
				makeUnmatched('/medium.mkv', 'multiple_matches', [
					{ tmdbId: 400, title: 'Medium Confidence', confidence: 0.7 }
				])
			)
			.run();

		const { data } = await postForceMatch({ minScore: 0.5 });
		expect((data as any).data.eligible).toBe(1);
		expect((data as any).data.matched).toBe(1);
		// Force Match All is a deliberate action: it now opts into the
		// replacement policy so a differently-named re-match doesn't leave a
		// duplicate file behind (issue #627).
		expect(mockAcceptMatch).toHaveBeenCalledWith(expect.any(String), 400, 'movie', {
			allowReplace: true
		});
	});

	it('happy path: two eligible files → acceptMatch called twice, matched: 2', async () => {
		testDb.db
			.insert(unmatchedFiles)
			.values([
				makeUnmatched('/a.mkv', 'multiple_matches', [
					{ tmdbId: 501, title: 'Film A', confidence: 0.95 }
				]),
				makeUnmatched('/b.mkv', 'multiple_matches', [
					{ tmdbId: 502, title: 'Film B', confidence: 0.92 }
				])
			])
			.run();

		const { status, data } = await postForceMatch();
		expect(status).toBe(200);
		expect((data as any).data).toEqual({ matched: 2, failed: 0, eligible: 2 });
		expect(mockAcceptMatch).toHaveBeenCalledTimes(2);
	});

	it('partial failure: acceptMatch throws for one file → { matched: 1, failed: 1, eligible: 2 }', async () => {
		testDb.db
			.insert(unmatchedFiles)
			.values([
				makeUnmatched('/ok.mkv', 'multiple_matches', [
					{ tmdbId: 601, title: 'OK Film', confidence: 0.95 }
				]),
				makeUnmatched('/bad.mkv', 'multiple_matches', [
					{ tmdbId: 602, title: 'Bad Film', confidence: 0.95 }
				])
			])
			.run();

		mockAcceptMatch
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('TMDB API error'));

		const { status, data } = await postForceMatch();
		expect(status).toBe(200);
		expect((data as any).data.matched).toBe(1);
		expect((data as any).data.failed).toBe(1);
		expect((data as any).data.eligible).toBe(2);
	});

	it('excludes files with null suggestedMatches', async () => {
		testDb.db
			.insert(unmatchedFiles)
			.values(makeUnmatched('/no-suggestions.mkv', 'multiple_matches', null))
			.run();

		const { data } = await postForceMatch();
		expect((data as any).data.eligible).toBe(0);
	});

	it('excludes files whose top candidate score is exactly at minScore boundary (>= check)', async () => {
		testDb.db
			.insert(unmatchedFiles)
			.values([
				makeUnmatched('/exact.mkv', 'multiple_matches', [
					{ tmdbId: 700, title: 'Exact Score', confidence: 0.9 }
				])
			])
			.run();

		// confidence 0.9 >= 0.9 (default) — should be eligible
		const { data } = await postForceMatch();
		expect((data as any).data.eligible).toBe(1);
		expect((data as any).data.matched).toBe(1);
	});
});
