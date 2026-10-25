import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeGrabDecisionContext } from '../../../test/fixtures/filters.js';

const mockIsBlocklisted = vi.hoisted(() => vi.fn());
const mockCalculateEnhancedScore = vi.hoisted(() => vi.fn());
const mockParse = vi.hoisted(() => vi.fn());
const mockIsUpgrade = vi.hoisted(() => vi.fn());
const mockBuildExistingAttrs = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/blocklist/BlocklistService.js', () => ({
	blocklistService: { isBlocklisted: mockIsBlocklisted }
}));

vi.mock('#lib/server/quality/QualityFilter.js', () => ({
	qualityFilter: { calculateEnhancedScore: mockCalculateEnhancedScore }
}));

vi.mock('#lib/server/indexers/parser/ReleaseParser.js', () => ({
	ReleaseParser: class {
		parse = mockParse;
	}
}));

vi.mock('#lib/server/db/index.js', () => ({
	db: {
		select: () => ({
			from: () => ({
				where: () => Object.assign([], { limit: () => ({ all: () => [], get: () => undefined }) })
			})
		}),
		query: {
			movies: { findFirst: vi.fn().mockResolvedValue(null) },
			tvShows: { findFirst: vi.fn().mockResolvedValue(null) },
			delayProfiles: {
				findFirst: vi.fn().mockResolvedValue(null),
				findMany: vi.fn().mockResolvedValue([])
			}
		}
	}
}));

vi.mock('#lib/server/settings/blocked-extensions.js', () => ({
	resolveBlockedExtensionsForQueueItem: vi.fn().mockReturnValue([])
}));

vi.mock('#lib/server/scoring/scorer.js', () => ({
	isUpgrade: mockIsUpgrade
}));

vi.mock('#lib/server/monitoring/specifications/utils.js', () => ({
	buildExistingAttrs: mockBuildExistingAttrs
}));

vi.mock('drizzle-orm', () => ({
	and: vi.fn(),
	eq: vi.fn(),
	inArray: vi.fn(),
	isNull: vi.fn(),
	like: vi.fn(),
	or: vi.fn(),
	notInArray: vi.fn(),
	sql: vi.fn()
}));

vi.mock('#lib/server/db/schema.js', () => ({
	downloadQueue: {
		id: 'id',
		infoHash: 'infoHash',
		movieId: 'movieId',
		status: 'status',
		importedAt: 'importedAt'
	},
	movieFiles: { id: 'id', movieId: 'movieId' },
	movies: { id: 'id', hasFile: 'hasFile' },
	delayProfiles: { id: 'id', enabled: 'enabled', isDefault: 'isDefault' },
	acquisitionIntents: {
		id: 'id',
		status: 'status',
		queueId: 'queueId',
		identityValue: 'identityValue'
	},
	acquisitionReservations: {
		intentId: 'intentId',
		targetKey: 'targetKey',
		releasedAt: 'releasedAt'
	}
}));

const { GrabDecisionPipeline } = await import('./GrabDecisionPipeline.js');

function setupPassingScoring() {
	mockParse.mockReturnValue({ originalTitle: 'Movie.2024.1080p.BluRay.x264-GROUP' });
	mockCalculateEnhancedScore.mockReturnValue({
		scoringResult: {
			totalScore: 150,
			isBanned: false,
			bannedReasons: [],
			sizeRejected: false,
			sizeRejectionReason: undefined,
			protocolRejected: false,
			protocolRejectionReason: undefined,
			meetsMinimum: true
		},
		score: 150
	});
}

describe('GrabDecisionPipeline', () => {
	const pipeline = new GrabDecisionPipeline();

	beforeEach(() => {
		vi.clearAllMocks();
		mockIsBlocklisted.mockResolvedValue({ blocked: false });
		mockBuildExistingAttrs.mockReturnValue({});
		setupPassingScoring();
	});

	it('accepts a new release with no existing files', async () => {
		const ctx = makeGrabDecisionContext();
		const decision = await pipeline.evaluate(ctx);

		expect(decision.accepted).toBe(true);
		expect(decision.upgradeStatus).toBe('new');
		expect(decision.scores.candidate).toBe(150);
		expect(decision.scores.existing).toBeUndefined();
		expect(decision.rejectionType).toBeUndefined();
	});

	it('skips most stages when force is true', async () => {
		const ctx = makeGrabDecisionContext({
			options: { force: true, skipBlocklist: false, allowSidegrade: false, isAutomatic: false },
			existingFiles: [
				{
					id: 'f1',
					relativePath: '/movies/existing.mkv',
					sceneName: 'Movie.2024.720p.WEB-DL'
				}
			]
		});

		const decision = await pipeline.evaluate(ctx);

		expect(decision.accepted).toBe(true);
		const skippedStages = decision.audit.stages.filter((s) => s.skipped);
		expect(skippedStages.length).toBeGreaterThanOrEqual(5);
	});

	it('rejects oversized releases when force is false', async () => {
		mockCalculateEnhancedScore.mockReturnValue({
			scoringResult: {
				totalScore: 150,
				isBanned: false,
				bannedReasons: [],
				sizeRejected: true,
				sizeRejectionReason: 'Movie size 3.66 GB exceeds maximum 2.5 GB',
				protocolRejected: false,
				protocolRejectionReason: undefined,
				meetsMinimum: true
			},
			score: 150
		});

		const ctx = makeGrabDecisionContext({
			options: { force: false, skipBlocklist: false, allowSidegrade: false, isAutomatic: false }
		});
		const decision = await pipeline.evaluate(ctx);

		expect(decision.accepted).toBe(false);
		expect(decision.rejectionType).toBe('size_rejected');
	});

	it('skips size validation when force is true (manual grab override)', async () => {
		mockCalculateEnhancedScore.mockReturnValue({
			scoringResult: {
				totalScore: 150,
				isBanned: false,
				bannedReasons: [],
				sizeRejected: true,
				sizeRejectionReason: 'Movie size 3.66 GB exceeds maximum 2.5 GB',
				protocolRejected: false,
				protocolRejectionReason: undefined,
				meetsMinimum: true
			},
			score: 150
		});

		const ctx = makeGrabDecisionContext({
			options: { force: true, skipBlocklist: false, allowSidegrade: false, isAutomatic: false }
		});
		const decision = await pipeline.evaluate(ctx);

		expect(decision.accepted).toBe(true);
		const sizeStage = decision.audit.stages.find((s) => s.name === 'sizeValidation');
		expect(sizeStage?.skipped).toBe(true);
	});

	it('produces correct stage names and timing in audit trail', async () => {
		const ctx = makeGrabDecisionContext();
		const decision = await pipeline.evaluate(ctx);

		const stageNames = decision.audit.stages.map((s) => s.name);
		expect(stageNames).toEqual([
			'identity',
			'blocklist',
			'scoring',
			'bannedFormat',
			'requiredFormats',
			'language',
			'sizeValidation',
			'protocol',
			'minimumScore',
			'duplicateHash',
			'mediaOccupancy',
			'blockedExtension',
			'upgrade',
			'delay'
		]);
		expect(decision.audit.totalDurationMs).toBeGreaterThanOrEqual(0);
		for (const stage of decision.audit.stages) {
			expect(stage.durationMs).toBeGreaterThanOrEqual(0);
		}
	});

	it('rejects a blocklisted release with correct rejectionType', async () => {
		mockIsBlocklisted.mockResolvedValue({ blocked: true, reason: 'Manually blocklisted' });

		const ctx = makeGrabDecisionContext();
		const decision = await pipeline.evaluate(ctx);

		expect(decision.accepted).toBe(false);
		expect(decision.rejectionType).toBe('blocklisted');
		expect(decision.reason).toBe('Manually blocklisted');
	});

	it('rejects a banned format release with correct rejectionType', async () => {
		mockParse.mockReturnValue({ originalTitle: 'Bad.Movie.YIFY' });
		mockCalculateEnhancedScore.mockReturnValue({
			scoringResult: {
				totalScore: -999999,
				isBanned: true,
				bannedReasons: ['YIFY'],
				sizeRejected: false,
				sizeRejectionReason: undefined,
				protocolRejected: false,
				protocolRejectionReason: undefined,
				meetsMinimum: false
			},
			score: -999999
		});

		const ctx = makeGrabDecisionContext();
		const decision = await pipeline.evaluate(ctx);

		expect(decision.accepted).toBe(false);
		expect(decision.rejectionType).toBe('banned');
		expect(decision.reason).toContain('Banned format');
	});
});
