/**
 * Indexer Interface Types
 *
 * Defines the contract that all indexers must implement.
 * Separated from implementation for clean dependency management.
 */

import type { IndexerProtocol } from './protocol';
import type { IndexerAccessType } from './accessType';
import type { IndexerCapabilities } from './definition';
import type { SearchCriteria } from './search';
import type { ReleaseResult } from './release';
import type { IndexerConfig } from './config';
import type { ProtocolSettings } from './index.js';

// =============================================================================
// INDEXER INTERFACE
// =============================================================================

/**
 * Core indexer interface that all indexers must implement
 */
export interface IIndexer {
	/** Unique instance ID */
	readonly id: string;
	/** Display name */
	readonly name: string;
	/** Definition ID this indexer is based on */
	readonly definitionId: string;
	/** Protocol (torrent/usenet/streaming) */
	readonly protocol: IndexerProtocol;
	/** Access type (public/semi-private/private) */
	readonly accessType: IndexerAccessType;
	/** Indexer capabilities */
	readonly capabilities: IndexerCapabilities;
	/** Base URL for this indexer instance */
	readonly baseUrl: string;
	/** Protocol-specific settings (torrent/usenet/streaming settings) */
	readonly protocolSettings?: ProtocolSettings;

	// Search capability toggles
	/** Whether automatic search is enabled */
	readonly enableAutomaticSearch: boolean;
	/** Whether interactive/manual search is enabled */
	readonly enableInteractiveSearch: boolean;

	/**
	 * User-configured category restriction ("restrict searches to only these
	 * categories"). Empty means no restriction - either it was never
	 * configured, or the user explicitly chose "open search" - see
	 * `restrictionAllowsSearchType()`, which treats both the same way.
	 */
	readonly additionalCategories: number[];

	/**
	 * Perform a search
	 * @param criteria - Search criteria
	 * @returns Release results
	 */
	search(criteria: SearchCriteria): Promise<ReleaseResult[]>;

	/**
	 * Test connectivity and authentication
	 * @throws Error if test fails
	 */
	test(): Promise<void>;

	/**
	 * Get the download URL for a release (resolves if needed)
	 * @param release - The release to get download URL for
	 * @returns The download URL
	 * @deprecated Use downloadTorrent() instead, which handles full download resolution
	 */
	getDownloadUrl?(release: ReleaseResult): Promise<string>;

	/**
	 * Check if this indexer can handle the given search criteria
	 * @param criteria - Search criteria to check
	 * @returns Whether this indexer can search with the given criteria
	 */
	canSearch(criteria: SearchCriteria): boolean;

	/**
	 * Download content from the indexer (torrent file, NZB, etc.)
	 * @param url - The download URL
	 * @returns Download result with file data or redirect info
	 * @deprecated Use downloadTorrent for backwards compatibility
	 */
	download?(url: string): Promise<IndexerDownloadResult>;

	/**
	 * Download a torrent/NZB file from the indexer.
	 * Handles authentication, cookies, and redirect following (including magnet: redirects).
	 * @param url - The download URL (torrent file URL, not magnet)
	 * @param options - Optional context for download resolution (e.g., release details URL)
	 * @returns Download result with file data or magnet redirect
	 */
	downloadTorrent?(url: string, options?: DownloadTorrentOptions): Promise<IndexerDownloadResult>;
}

// =============================================================================
// DOWNLOAD OPTIONS
// =============================================================================

/**
 * Optional context passed to downloadTorrent for YAML-based download resolution.
 * Provides release metadata that may be needed to resolve the actual download URL
 * (e.g., indexers that require fetching a details page first).
 */
export interface DownloadTorrentOptions {
	/** URL to the release details/comments page (used by downloadVariablesFrom: details) */
	releaseDetailsUrl?: string;
	/** Release GUID for template variable substitution */
	releaseGuid?: string;
	/** Release title for template variable substitution */
	releaseTitle?: string;
}

// =============================================================================
// DOWNLOAD RESULT
// =============================================================================

/**
 * Result of downloading content from an indexer
 */
export interface IndexerDownloadResult {
	/** Whether the download was successful */
	success: boolean;
	/** The raw file data (torrent file, NZB, or strm content) */
	data?: Buffer;
	/** If the response was a magnet redirect */
	magnetUrl?: string;
	/** Info hash extracted from torrent file */
	infoHash?: string;
	/** Error message if download failed */
	error?: string;
	/** Response time in milliseconds */
	responseTimeMs?: number;
}

// =============================================================================
// HTTP INDEXER INTERFACE
// =============================================================================

/**
 * HTTP request details
 */
export interface IndexerRequest {
	url: string;
	method: 'GET' | 'POST';
	headers: Record<string, string>;
	body?: string | URLSearchParams;
	/** Expected response type */
	responseType: 'json' | 'xml' | 'html';
}

/**
 * Request generator interface
 */
export interface IIndexerRequestGenerator {
	/** Build request for the given search criteria */
	buildRequest(criteria: SearchCriteria): IndexerRequest;
	/** Build request for fetching a download URL */
	buildDownloadRequest?(releaseUrl: string): IndexerRequest;
}

/**
 * Response parser interface
 */
export interface IIndexerResponseParser {
	/** Parse response into release results */
	parse(response: string, indexerId: string, indexerName: string): ReleaseResult[];
}

/**
 * Extended interface for HTTP-based indexers
 */
export interface IHttpIndexer extends IIndexer {
	/** Request generator */
	readonly requestGenerator: IIndexerRequestGenerator;
	/** Response parser */
	readonly responseParser: IIndexerResponseParser;
	/** Execute an HTTP request */
	executeRequest(request: IndexerRequest): Promise<string>;
}

// =============================================================================
// PROTOCOL-SPECIFIC INTERFACES
// =============================================================================

/**
 * Torrent-specific indexer interface
 */
export interface ITorrentIndexer extends IHttpIndexer {
	/** Get magnet URL for a release */
	getMagnetUrl(release: ReleaseResult): Promise<string>;
}

/**
 * Usenet-specific indexer interface
 */
export interface IUsenetIndexer extends IHttpIndexer {
	/** Get NZB URL */
	getNzbUrl(release: ReleaseResult): Promise<string>;
}

/**
 * Streaming-specific indexer interface
 */
export interface IStreamingIndexer extends IIndexer {
	/** Get stream URL */
	getStreamUrl(release: ReleaseResult): Promise<string>;
	/** Get available qualities for a release */
	getAvailableQualities(release: ReleaseResult): Promise<string[]>;
}

// =============================================================================
// FACTORY INTERFACE
// =============================================================================

/**
 * Factory for creating indexer instances
 */
export interface IIndexerFactory {
	/** Create an indexer instance from config */
	createIndexer(config: IndexerConfig): IIndexer | Promise<IIndexer>;
	/** Check if factory can handle a definition */
	canHandle(definitionId: string): boolean;
}
