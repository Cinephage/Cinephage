import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import { subtitleProviders } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import type { SubtitleSearchCriteria } from '../types';

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

const { SubtitleProviderManager } = await import('./SubtitleProviderManager');
const { SubtitleSearchService } = await import('./SubtitleSearchService');
const { SubtitleScoringService } = await import('./SubtitleScoringService');
const { getSubtitleProviderFactory, initializeProviderFactory } =
	await import('../providers/SubtitleProviderFactory');

describe('Subtitle System Integration', () => {
	let providerManager: ReturnType<typeof SubtitleProviderManager.getInstance>;
	let searchService: ReturnType<typeof SubtitleSearchService.getInstance>;
	let scoringService: ReturnType<typeof SubtitleScoringService.getInstance>;
	let testProviderId: string | null = null;

	beforeAll(async () => {
		await initializeProviderFactory();

		providerManager = SubtitleProviderManager.getInstance();
		searchService = SubtitleSearchService.getInstance();
		scoringService = SubtitleScoringService.getInstance();
	});

	afterAll(async () => {
		if (testProviderId) {
			await testDb.db.delete(subtitleProviders).where(eq(subtitleProviders.id, testProviderId));
		}
		destroyTestDb(testDb);
	});

	describe('Provider Factory', () => {
		it('should have registered provider implementations', () => {
			const factory = getSubtitleProviderFactory();
			const implementations = factory.getSupportedImplementations();

			expect(implementations).toContain('opensubtitles');
			expect(implementations).toContain('addic7ed');
			expect(implementations).toContain('subf2m');
			expect(implementations).toContain('yifysubtitles');
		});

		it('should return provider definitions with required metadata', () => {
			const factory = getSubtitleProviderFactory();
			const definitions = factory.getDefinitions();

			expect(definitions.length).toBeGreaterThan(0);

			for (const def of definitions) {
				expect(def.implementation).toBeDefined();
				expect(def.name).toBeDefined();
				expect(def.supportedLanguages).toBeInstanceOf(Array);
				expect(def.supportedLanguages.length).toBeGreaterThan(0);
			}
		});

		it('should correctly identify OpenSubtitles as requiring API key', () => {
			const factory = getSubtitleProviderFactory();
			const osDef = factory.getDefinition('opensubtitles');

			expect(osDef).toBeDefined();
			expect(osDef!.requiresApiKey).toBe(true);
		});

		it('should correctly identify Subf2m as not requiring API key', () => {
			const factory = getSubtitleProviderFactory();
			const subf2mDef = factory.getDefinition('subf2m');

			expect(subf2mDef).toBeDefined();
			expect(subf2mDef!.requiresApiKey).toBe(false);
		});
	});

	describe('Provider Manager', () => {
		it('should be able to create a provider configuration', async () => {
			const config = await providerManager.createProvider({
				name: 'Test Subf2m',
				implementation: 'subf2m',
				enabled: false,
				priority: 50,
				requestsPerMinute: 30
			});

			testProviderId = config.id;

			expect(config.id).toBeDefined();
			expect(config.name).toBe('Test Subf2m');
			expect(config.implementation).toBe('subf2m');
			expect(config.enabled).toBe(false);
		});

		it('should retrieve the created provider', async () => {
			if (!testProviderId) {
				throw new Error('Test provider not created');
			}

			const config = await providerManager.getProvider(testProviderId);
			expect(config).toBeDefined();
			expect(config!.name).toBe('Test Subf2m');
		});

		it('should be able to get a provider instance', async () => {
			if (!testProviderId) {
				throw new Error('Test provider not created');
			}

			const instance = await providerManager.getProviderInstance(testProviderId);
			expect(instance).toBeDefined();
		});

		it('should correctly track provider health status', async () => {
			const health = await providerManager.getHealthStatus();
			expect(health).toBeInstanceOf(Array);

			if (testProviderId) {
				const testHealth = health.find(
					(h: { providerId: string }) => h.providerId === testProviderId
				);
				expect(testHealth).toBeDefined();
				expect(testHealth!.isHealthy).toBe(true);
				expect(testHealth!.consecutiveFailures).toBe(0);
			}
		});

		it('should not return disabled providers from getEnabledProviders', async () => {
			const enabled = await providerManager.getEnabledProviders();
			const hasTestProvider = enabled.some((p: { id: string }) => p.id === testProviderId);
			expect(hasTestProvider).toBe(false);
		});
	});

	describe('Scoring Service', () => {
		const movieCriteria: SubtitleSearchCriteria = {
			title: 'The Matrix',
			year: 1999,
			imdbId: 'tt0133093',
			languages: ['en']
		};

		it('should score hash matches higher than text matches', () => {
			const hashResult = {
				providerId: 'test',
				providerName: 'Test',
				providerSubtitleId: '123',
				language: 'en',
				title: 'The Matrix 1999',
				releaseName: 'The.Matrix.1999.1080p.BluRay.x264',
				format: 'srt' as const,
				isHashMatch: true,
				isForced: false,
				isHearingImpaired: false,
				matchScore: 0,
				downloadCount: 1000
			};

			const textResult = {
				...hashResult,
				isHashMatch: false
			};

			const hashScore = scoringService.score(hashResult, movieCriteria);
			const textScore = scoringService.score(textResult, movieCriteria);

			expect(hashScore).toBeGreaterThan(textScore);
			expect(hashScore).toBeGreaterThanOrEqual(100);
		});

		it('should calculate episode scores on the shared 0-100 scale', () => {
			const episodeCriteria: SubtitleSearchCriteria = {
				title: 'Breaking Bad',
				seriesTitle: 'Breaking Bad',
				season: 1,
				episode: 1,
				year: 2008,
				languages: ['en']
			};

			const hashResult = {
				providerId: 'test',
				providerName: 'Test',
				providerSubtitleId: '123',
				language: 'en',
				title: 'Breaking Bad S01E01',
				format: 'srt' as const,
				isHashMatch: true,
				isForced: false,
				isHearingImpaired: false,
				matchScore: 0,
				downloadCount: 5000
			};

			const score = scoringService.score(hashResult, episodeCriteria);
			expect(score).toBe(100);
		});
	});

	describe('Search Service', () => {
		it('should have search method available', () => {
			expect(searchService.search).toBeDefined();
			expect(typeof searchService.search).toBe('function');
		});

		it('should have searchForMovie method available', () => {
			expect(searchService.searchForMovie).toBeDefined();
			expect(typeof searchService.searchForMovie).toBe('function');
		});

		it('should have searchForEpisode method available', () => {
			expect(searchService.searchForEpisode).toBeDefined();
			expect(typeof searchService.searchForEpisode).toBe('function');
		});
	});

	describe('End-to-end flow validation', () => {
		it('should have all components properly connected', () => {
			expect(SubtitleProviderManager.getInstance()).toBe(providerManager);
			expect(SubtitleSearchService.getInstance()).toBe(searchService);
			expect(SubtitleScoringService.getInstance()).toBe(scoringService);
		});

		it('should have provider factory with all expected providers', () => {
			const factory = getSubtitleProviderFactory();
			const defs = factory.getDefinitions();

			const implementations = defs.map((d) => d.implementation);
			expect(implementations).toContain('opensubtitles');
			expect(implementations).toContain('addic7ed');
			expect(implementations).toContain('yifysubtitles');
			expect(implementations).toContain('subf2m');
		});
	});
});

describe('Provider Implementation Smoke Tests', () => {
	it('should be able to instantiate OpenSubtitles provider (with mock config)', () => {
		const factory = getSubtitleProviderFactory();
		const provider = factory.createProvider({
			id: 'test-os',
			name: 'Test OpenSubtitles',
			implementation: 'opensubtitles',
			enabled: true,
			priority: 1,
			apiKey: 'test-key',
			consecutiveFailures: 0,
			requestsPerMinute: 60
		});

		expect(provider).toBeDefined();
		expect(provider.id).toBe('test-os');
	});

	it('should be able to instantiate Subf2m provider', () => {
		const factory = getSubtitleProviderFactory();
		const provider = factory.createProvider({
			id: 'test-subf2m',
			name: 'Test Subf2m',
			implementation: 'subf2m',
			enabled: true,
			priority: 1,
			consecutiveFailures: 0,
			requestsPerMinute: 60
		});

		expect(provider).toBeDefined();
		expect(provider.id).toBe('test-subf2m');
	});

	it('should be able to instantiate YIFY Subtitles provider', () => {
		const factory = getSubtitleProviderFactory();
		const provider = factory.createProvider({
			id: 'test-yify',
			name: 'Test YIFY',
			implementation: 'yifysubtitles',
			enabled: true,
			priority: 1,
			consecutiveFailures: 0,
			requestsPerMinute: 60
		});

		expect(provider).toBeDefined();
		expect(provider.id).toBe('test-yify');
	});

	it('should be able to instantiate Addic7ed provider', () => {
		const factory = getSubtitleProviderFactory();
		const provider = factory.createProvider({
			id: 'test-add',
			name: 'Test Addic7ed',
			implementation: 'addic7ed',
			enabled: true,
			priority: 1,
			consecutiveFailures: 0,
			requestsPerMinute: 60
		});

		expect(provider).toBeDefined();
		expect(provider.id).toBe('test-add');
	});
});
