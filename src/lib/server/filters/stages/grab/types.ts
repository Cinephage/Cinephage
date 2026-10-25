import type { ScoringProfile, ScoringResult } from '#lib/server/scoring/types.js';
import type { Resolution } from '#lib/server/indexers/parser/types.js';
import type { DecisionAudit } from '../../types.js';

export type UpgradeStatus = 'new' | 'upgrade' | 'sidegrade' | 'downgrade' | 'blocked' | 'rejected';

export type RejectionType =
	| 'identity_mismatch'
	| 'blocklisted'
	| 'banned'
	| 'size_rejected'
	| 'protocol_rejected'
	| 'below_minimum'
	| 'duplicate_hash'
	| 'media_occupied'
	| 'blocked_extension'
	| 'not_upgrade'
	| 'upgrades_disabled'
	| 'pending_delay'
	| 'missing_required_format';

export interface ReleaseInfo {
	title: string;
	infoHash?: string;
	magnetUrl?: string;
	downloadUrl?: string;
	indexerId?: string;
	indexerName?: string;
	size?: number;
	protocol?: 'torrent' | 'usenet' | 'streaming';
	category?: string;
	/** When the release was first published on the indexer */
	publishDate?: Date;
	/** External IDs asserted by the indexer/search result, when available. */
	tmdbId?: number;
	imdbId?: string;
	tvdbId?: number;
}

export interface ExistingFile {
	id: string;
	relativePath: string;
	sceneName?: string | null;
	size?: number | null;
	quality?: { resolution?: string; source?: string; codec?: string; hdr?: string } | null;
	releaseGroup?: string | null;
	episodeIds?: string[] | null;
}

export interface MovieTarget {
	type: 'movie';
	movieId: string;
}

export interface EpisodeTarget {
	type: 'episode';
	episodeId: string;
	seriesId: string;
}

export interface SeasonTarget {
	type: 'season';
	seriesId: string;
	seasonNumber: number;
	episodeIds: string[];
}

export interface SeriesTarget {
	type: 'series';
	seriesId: string;
	episodeIds: string[];
}

export type GrabTarget = MovieTarget | EpisodeTarget | SeasonTarget | SeriesTarget;

/**
 * Resolved identity facts about the grab target, used by the (hard)
 * IdentityStage to verify the release actually refers to the target media.
 * Built once by GrabService.resolveTarget; never hand-assembled elsewhere.
 */
export interface TargetIdentityInfo {
	mediaType: 'movie' | 'tv';
	/** Canonical title + original title + curated alternates. */
	titles: string[];
	/** Movie release year / series first-air year. */
	year?: number;
	/** External IDs of the target, used to accept ID-asserted releases. */
	tmdbId?: number;
	imdbId?: string | null;
	tvdbId?: number | null;
	/** Season number when the target is season-scoped. */
	seasonNumber?: number;
	/**
	 * Absolute episode coordinates the target covers. Present for episode,
	 * season, and series targets whose episode scope resolved to concrete
	 * episodes; used for season/episode scope-consistency checks.
	 */
	episodeScope?: { seasonNumber: number; episodeNumber: number }[];
}

export interface GrabDecisionOptions {
	force: boolean;
	skipBlocklist: boolean;
	allowSidegrade: boolean;
	isAutomatic: boolean;
	/**
	 * Explicit hard-override (admin "override rejected release" flows). When
	 * true, the hard stages (blocklist, duplicate-hash, media-occupancy) are
	 * skipped. Plain manual grabs set `force` to skip policy only — they must
	 * still pass identity and the hard stages. Identity ignores this flag
	 * entirely and always runs.
	 */
	overrideHardStages?: boolean;
	isUpgrade?: boolean;
	/** Skip the delay stage - used when processing a release that has already waited its delay period */
	skipDelay?: boolean;
}

export interface GrabDecisionContext {
	release: ReleaseInfo;
	target: GrabTarget;
	existingFiles: ExistingFile[];
	profile: ScoringProfile;
	options: GrabDecisionOptions;
	/** Per-movie desired qualities (multi-quality mode). Movies only. */
	desiredQualities?: Resolution[];
	/** Identity facts about the target; drives the hard IdentityStage. */
	targetInfo?: TargetIdentityInfo;
	computed: {
		scoringResult?: ScoringResult;
		candidateScore?: number;
		existingScore?: number;
		upgradeStatus?: UpgradeStatus;
		isBanned?: boolean;
		bannedReasons?: string[];
		sizeRejected?: boolean;
		sizeRejectionReason?: string;
		protocolRejected?: boolean;
		protocolRejectionReason?: string;
		meetsMinimum?: boolean;
	};
}

export interface UpgradeStats {
	improved: number;
	unchanged: number;
	downgraded: number;
	newEpisodes: number;
}

export interface GrabDecision {
	accepted: boolean;
	reason: string;
	rejectionType?: RejectionType;
	upgradeStatus: UpgradeStatus;
	scores: { candidate: number; existing?: number; improvement?: number };
	upgradeStats?: UpgradeStats;
	audit: DecisionAudit;
}
