/**
 * Score Types
 *
 * Types for score visibility API responses
 */

import type {
	ScoringResult,
	ReleaseAttributes,
	ScoreBreakdown
} from '#lib/server/scoring/types.js';

/**
 * Upgrade status for a file
 */
export interface UpgradeStatus {
	/** Whether upgrades are allowed for this profile */
	upgradesAllowed: boolean;
	/** Score threshold to stop searching for upgrades (-1 = unlimited) */
	upgradeUntilScore: number;
	/** Current file's score */
	currentScore: number;
	/** Whether file is at or above cutoff */
	isAtCutoff: boolean;
	/** Whether file meets minimum score threshold */
	meetsMinimum: boolean;
	/** Minimum improvement needed for upgrade */
	minScoreIncrement: number;
}

/**
 * Profile information for display
 */
export interface ProfileInfo {
	id: string;
	name: string;
	minScore: number;
	minScoreIncrement: number;
	upgradeUntilScore: number;
}

/**
 * Complete score result for an existing file (API response)
 */
export interface FileScoreResponse {
	/** File ID */
	fileId: string;
	/** File name/path for display */
	fileName: string;
	/** Scene name if available */
	sceneName: string | null;
	/** Full scoring result from the engine */
	scoringResult: ScoringResult;
	/** Normalized score (0-1000) for comparison with search results */
	normalizedScore: number;
	/** Upgrade eligibility status */
	upgradeStatus: UpgradeStatus;
	/** Profile information */
	profileInfo: ProfileInfo;
	/** Detected attributes from the file */
	attributes: ReleaseAttributes;
	/** Where quality data came from */
	dataSource: 'stored' | 'parsed';
}

// Re-export useful types from scoring engine
export type { ScoringResult, ReleaseAttributes, ScoreBreakdown };
