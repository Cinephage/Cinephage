import { randomUUID } from 'node:crypto';
import type { ReleaseAttributes } from '#lib/server/scoring/types.js';

const FIXED_DATE = '2024-01-01T00:00:00.000Z';

export function createReleaseAttributes(overrides?: Partial<ReleaseAttributes>): ReleaseAttributes {
	return {
		title: 'Movie.2024.2160p.UHD.BluRay.REMUX.HEVC.TrueHD.Atmos.7.1-GROUP',
		cleanTitle: 'Movie',
		year: 2024,
		resolution: '2160p',
		source: 'remux',
		codec: 'h265',
		hdr: null,
		audioCodec: 'truehd',
		audioChannels: '7.1',
		hasAtmos: true,
		releaseGroup: 'GROUP',
		streamingService: undefined,
		edition: undefined,
		languages: ['en'],
		indexerName: undefined,
		isRemux: true,
		isRepack: false,
		isProper: false,
		is3d: false,
		isSeasonPack: undefined,
		isCompleteSeries: undefined,
		seasonCount: undefined,
		...overrides
	};
}

export interface SearchReleaseFixture {
	title: string;
	size: number;
	parsed: Record<string, unknown>;
	indexerId: string;
	indexerName: string;
	protocol: string;
	infoHash: string;
	downloadUrl: string;
	magnetUrl: string | null;
	totalScore: number;
	guid?: string;
	episodeMatch?: Record<string, unknown>;
}

export function createSearchRelease(
	overrides?: Partial<SearchReleaseFixture>
): SearchReleaseFixture {
	return {
		title: 'Test.Movie.2024.1080p.WEB-DL.H264-GROUP',
		size: 2_000_000_000,
		parsed: { resolution: '1080p', source: 'webdl', codec: 'h264', hdr: null },
		indexerId: 'indexer-1',
		indexerName: 'Test Indexer',
		protocol: 'torrent',
		infoHash: 'abc123def456',
		downloadUrl: 'https://example.test/download/1',
		magnetUrl: null,
		totalScore: 100,
		...overrides
	};
}

export interface GrabResponseFixture {
	success: boolean;
	decision: {
		accepted: boolean;
		reason: string;
		upgradeStatus: string;
		scores: { candidate: number };
		audit: { stages: unknown[] };
	};
	download: {
		queueId: string;
		clientId: string;
		clientName: string;
		category: string;
		wasDuplicate: boolean;
		isUpgrade: boolean;
	};
}

export function createGrabResponse(overrides?: Partial<GrabResponseFixture>): GrabResponseFixture {
	return {
		success: true,
		decision: {
			accepted: true,
			reason: 'ok',
			upgradeStatus: 'new',
			scores: { candidate: 100 },
			audit: { stages: [] }
		},
		download: {
			queueId: 'queue-1',
			clientId: 'c1',
			clientName: 'test',
			category: 'tv',
			wasDuplicate: false,
			isUpgrade: false
		},
		...overrides
	};
}

export interface ScoringResultFixture {
	releaseName: string;
	profile: string;
	totalScore: number;
	breakdown: Record<string, number>;
	matchedFormats: unknown[];
	meetsMinimum: boolean;
	isBanned: boolean;
	bannedReasons: string[];
	sizeRejected: boolean;
	sizeRejectionReason?: string;
	protocolRejected: boolean;
	protocolRejectionReason?: string;
}

export function createScoringResult(
	overrides?: Partial<ScoringResultFixture>
): ScoringResultFixture {
	return {
		releaseName: 'Movie.2024.1080p.WEB-DL.x264-GROUP',
		profile: 'balanced',
		totalScore: 150,
		breakdown: {
			resolution: 0,
			source: 0,
			codec: 0,
			hdr: 0,
			audio: 0,
			audioChannels: 0,
			releaseGroup: 0,
			micro: 0,
			custom: 0
		},
		matchedFormats: [],
		meetsMinimum: true,
		isBanned: false,
		bannedReasons: [],
		sizeRejected: false,
		sizeRejectionReason: undefined,
		protocolRejected: false,
		protocolRejectionReason: undefined,
		...overrides
	};
}

export interface ScoringProfileFixture {
	id: string;
	name: string;
	description: string;
	tags: string[];
	upgradesAllowed: boolean;
	minScore: number;
	upgradeUntilScore: number;
	minScoreIncrement: number;
	resolutionOrder: string[];
	formatScores: Record<string, number>;
	allowedProtocols: string[];
	isDefault: boolean;
	movieMinSizeGb: number | null;
	movieMaxSizeGb: number | null;
	episodeMinSizeMb: number | null;
	episodeMaxSizeMb: number | null;
	isBuiltIn: boolean;
	minResolution: string | null;
	maxResolution: string | null;
	allowedSources: string[] | null;
	excludedSources: string[] | null;
	createdAt: string;
	updatedAt: string;
}

export function createScoringProfile(
	overrides?: Partial<ScoringProfileFixture>
): ScoringProfileFixture {
	return {
		id: randomUUID(),
		name: 'Balanced',
		description: 'Balanced quality profile',
		tags: [],
		upgradesAllowed: true,
		minScore: 0,
		upgradeUntilScore: -1,
		minScoreIncrement: 10,
		resolutionOrder: ['2160p', '1080p', '720p', '480p'],
		formatScores: {},
		allowedProtocols: ['torrent', 'usenet'],
		isDefault: false,
		movieMinSizeGb: null,
		movieMaxSizeGb: null,
		episodeMinSizeMb: null,
		episodeMaxSizeMb: null,
		isBuiltIn: false,
		minResolution: null,
		maxResolution: null,
		allowedSources: null,
		excludedSources: null,
		createdAt: FIXED_DATE,
		updatedAt: FIXED_DATE,
		...overrides
	};
}

export interface CustomFormatFixture {
	id: string;
	name: string;
	description: string | null;
	category: string;
	tags: string[] | null;
	conditions: unknown[];
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export function createCustomFormat(overrides?: Partial<CustomFormatFixture>): CustomFormatFixture {
	return {
		id: randomUUID(),
		name: 'Test Format',
		description: null,
		category: 'other',
		tags: null,
		conditions: [],
		enabled: true,
		createdAt: FIXED_DATE,
		updatedAt: FIXED_DATE,
		...overrides
	};
}
