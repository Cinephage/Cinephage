import { db } from '#lib/server/db/index.js';
import { blockedKeywords, settings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { tmdb } from '#lib/server/tmdb.js';

const SEED_DONE_KEY = 'keyword_defaults_seeded';

const logger = createChildLogger({ logDomain: 'system' as const });

const DEFAULT_NSFW_KEYWORDS: Array<{ keywordId: number; name: string }> = [
	{ keywordId: 155477, name: 'softcore' },
	{ keywordId: 256466, name: 'erotic' },
	{ keywordId: 325693, name: 'erotica' },
	{ keywordId: 207767, name: 'erotic thriller' },
	{ keywordId: 155691, name: 'erotic vignettes' },
	{ keywordId: 10053, name: 'sexploitation' },
	{ keywordId: 445, name: 'pornography' },
	{ keywordId: 356759, name: 'porn' },
	{ keywordId: 360629, name: 'adult' },
	{ keywordId: 284535, name: 'adult video' },
	{ keywordId: 195997, name: 'adult filmmaking' },
	{ keywordId: 7344, name: 'porn star' },
	{ keywordId: 375524, name: 'hardcore' },
	{ keywordId: 5593, name: 'pornographic video' },
	{ keywordId: 6443, name: 'child pornography' },
	{ keywordId: 11474, name: 'sexual intercourse' },
	{ keywordId: 148534, name: 'cunnilingus' },
	{ keywordId: 3405, name: 'blow job' },
	{ keywordId: 354947, name: 'blowjob' },
	{ keywordId: 3201, name: 'orgasm' },
	{ keywordId: 11868, name: 'ejaculation' },
	{ keywordId: 155002, name: 'female ejaculation (squirt)' },
	{ keywordId: 33451, name: 'masturbation' },
	{ keywordId: 345093, name: 'female masturbation' },
	{ keywordId: 284609, name: 'mutual masturbation' },
	{ keywordId: 33432, name: 'male masturbation' },
	{ keywordId: 1817, name: 'orgy' },
	{ keywordId: 155262, name: 'threesome' },
	{ keywordId: 224066, name: 'gangbang' },
	{ keywordId: 910, name: 'bondage' },
	{ keywordId: 158713, name: 'bdsm' },
	{ keywordId: 3260, name: 'masochism' },
	{ keywordId: 6373, name: 'sadomasochism' },
	{ keywordId: 2699, name: 'fetish' },
	{ keywordId: 272673, name: 'sexual fetish' },
	{ keywordId: 7089, name: 'dominatrix' },
	{ keywordId: 246601, name: 'nude' },
	{ keywordId: 281741, name: 'nudity' },
	{ keywordId: 359980, name: 'female nudity' },
	{ keywordId: 360081, name: 'partial nudity' },
	{ keywordId: 326200, name: 'topless women' },
	{ keywordId: 6593, name: 'stripper' },
	{ keywordId: 164865, name: 'male stripper' },
	{ keywordId: 3276, name: 'peep show' },
	{ keywordId: 169815, name: 'exhibitionism' },
	{ keywordId: 180340, name: 'voyeur' },
	{ keywordId: 284196, name: 'upskirt' },
	{ keywordId: 333071, name: 'penis' },
	{ keywordId: 15129, name: 'vagina' },
	{ keywordId: 327115, name: 'erect penis' },
	{ keywordId: 9838, name: 'nymphomaniac' },
	{ keywordId: 186071, name: 'sexual pleasure' },
	{ keywordId: 738, name: 'sexuality' },
	{ keywordId: 11534, name: 'sexual violence' },
	{ keywordId: 159595, name: 'sexual torture' }
];

export interface BlockedKeywordEntry {
	id: number;
	keywordId: number;
	name: string;
	createdAt: string;
}

class KeywordBlocklistService {
	private static instance: KeywordBlocklistService;
	private cachedIds: number[] | null = null;
	private cacheTime: number = 0;
	private static CACHE_TTL = 30_000;

	static getInstance(): KeywordBlocklistService {
		if (!KeywordBlocklistService.instance) {
			KeywordBlocklistService.instance = new KeywordBlocklistService();
		}
		return KeywordBlocklistService.instance;
	}

	async getBlockedKeywordIds(): Promise<number[]> {
		const now = Date.now();
		if (this.cachedIds !== null && now - this.cacheTime < KeywordBlocklistService.CACHE_TTL) {
			return this.cachedIds;
		}

		const rows = await db.select({ keywordId: blockedKeywords.keywordId }).from(blockedKeywords);
		this.cachedIds = rows.map((r) => r.keywordId);
		this.cacheTime = now;
		return this.cachedIds;
	}

	async getBlockedKeywords(): Promise<BlockedKeywordEntry[]> {
		return db.select().from(blockedKeywords).orderBy(blockedKeywords.createdAt);
	}

	async addBlockedKeyword(keywordId: number): Promise<BlockedKeywordEntry> {
		const existing = await db
			.select()
			.from(blockedKeywords)
			.where(eq(blockedKeywords.keywordId, keywordId))
			.limit(1);

		if (existing.length > 0) {
			return existing[0] as BlockedKeywordEntry;
		}

		const keyword = await tmdb.keywordDetails(keywordId);

		const [entry] = await db
			.insert(blockedKeywords)
			.values({
				keywordId,
				name: keyword.name
			})
			.returning();

		this.cachedIds = null;
		logger.info({ keywordId, name: keyword.name }, '[KeywordBlocklist] Added keyword');

		return entry as BlockedKeywordEntry;
	}

	async removeBlockedKeyword(id: number): Promise<void> {
		await db.delete(blockedKeywords).where(eq(blockedKeywords.id, id));
		this.cachedIds = null;
	}

	async seedDefaults(force = false): Promise<number> {
		if (!force) {
			const alreadySeeded = await db.query.settings.findFirst({
				where: eq(settings.key, SEED_DONE_KEY)
			});
			if (alreadySeeded) return 0;
		}

		const existingRows = await db
			.select({ keywordId: blockedKeywords.keywordId })
			.from(blockedKeywords);
		const existingIds = new Set(existingRows.map((r) => r.keywordId));

		const missing = DEFAULT_NSFW_KEYWORDS.filter((k) => !existingIds.has(k.keywordId));

		if (missing.length > 0) {
			const now = new Date().toISOString();
			const values = missing.map((k) => ({
				keywordId: k.keywordId,
				name: k.name,
				createdAt: now
			}));

			await db.insert(blockedKeywords).values(values);
			this.cachedIds = null;
			logger.info({ count: values.length }, '[KeywordBlocklist] Seeded default NSFW keywords');
		}

		await db.insert(settings).values({ key: SEED_DONE_KEY, value: 'true' }).onConflictDoNothing();

		return missing.length;
	}

	invalidateCache(): void {
		this.cachedIds = null;
	}
}

export const keywordBlocklistService = KeywordBlocklistService.getInstance();
