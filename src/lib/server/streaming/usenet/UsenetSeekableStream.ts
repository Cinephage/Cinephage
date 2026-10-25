/**
 * UsenetSeekableStream - Readable stream with Range request support.
 *
 * Key features:
 * - HTTP Range request support for seeking
 * - Backpressure-aware streaming
 * - Progress reporting
 * - Clean resource cleanup
 */

import { Readable, type ReadableOptions } from 'node:stream';
import { createChildLogger } from '#lib/logging/index.js';
import type { NntpManager } from './NntpManager';

const logger = createChildLogger({
	logDomain: 'streams' as const,
	component: 'UsenetSeekableStream'
});
import { SegmentStore } from './SegmentStore';
import { AdaptivePrefetcher } from './AdaptivePrefetcher';
import type { ByteRange, NzbFile } from './types';

/**
 * Stream state.
 */
interface StreamState {
	currentSegmentIndex: number;
	positionInSegment: number;
	bytesStreamed: number;
	endByte: number;
	ended: boolean;
}

/**
 * Options for creating a UsenetSeekableStream.
 */
export interface UsenetSeekableStreamOptions {
	file: NzbFile;
	nntpManager: NntpManager;
	range?: ByteRange;
	onProgress?: (bytesStreamed: number, totalBytes: number) => void;
	/** Mount ID for DB cache lookups */
	mountId?: string;
	/** File index within the mount for DB cache lookups */
	fileIndex?: number;
}

/**
 * High water mark for backpressure (16MB).
 */
const HIGH_WATER_MARK = 16 * 1024 * 1024;

/**
 * UsenetSeekableStream streams usenet content with seeking support.
 */
export class UsenetSeekableStream extends Readable {
	private file: NzbFile;
	private store: SegmentStore;
	private prefetcher: AdaptivePrefetcher;
	private state: StreamState;
	private range: ByteRange | null;
	private onProgress?: (bytesStreamed: number, totalBytes: number) => void;
	private reading = false;
	private currentSegmentData: Buffer | null = null;
	private _isDestroyed = false;
	private mountId?: string;
	private fileIndex?: number;

	constructor(options: UsenetSeekableStreamOptions, readableOptions?: ReadableOptions) {
		super({ highWaterMark: HIGH_WATER_MARK, ...readableOptions });

		this.file = options.file;
		this.range = options.range ?? null;
		this.onProgress = options.onProgress;
		this.mountId = options.mountId;
		this.fileIndex = options.fileIndex;

		// Create segment store
		this.store = new SegmentStore(options.file.segments);

		// Create adaptive prefetcher with DB cache support
		this.prefetcher = new AdaptivePrefetcher(
			options.nntpManager,
			this.store,
			undefined, // config
			options.mountId,
			options.fileIndex
		);

		// Initialize state based on range
		this.state = this.initializeState();

		logger.debug(
			{
				mountId: this.mountId,
				fileIndex: this.fileIndex,
				file: this.file.name,
				totalSize: this.store.totalSize,
				segments: this.file.segments.length,
				range: this.range
			},
			'Created usenet seekable stream'
		);
	}

	/**
	 * Initialize stream state based on range.
	 */
	private initializeState(): StreamState {
		const totalSize = this.store.totalSize;

		if (this.range) {
			const startByte = this.range.start;
			const endByte =
				this.range.end === -1 ? totalSize - 1 : Math.min(this.range.end, totalSize - 1);

			const startLoc = this.store.findSegmentForOffset(startByte);
			if (!startLoc) {
				throw new Error(`Invalid range start: ${startByte}`);
			}

			// Notify prefetcher of initial position (like a seek)
			this.prefetcher.onSeek(startLoc.segmentIndex);

			return {
				currentSegmentIndex: startLoc.segmentIndex,
				positionInSegment: startLoc.offsetInSegment,
				bytesStreamed: 0,
				endByte,
				ended: false
			};
		}

		// Full file stream
		return {
			currentSegmentIndex: 0,
			positionInSegment: 0,
			bytesStreamed: 0,
			endByte: totalSize - 1,
			ended: false
		};
	}

	/**
	 * Get content length for this stream.
	 */
	get contentLength(): number {
		if (this.range) {
			const start = this.range.start;
			const end = this.range.end === -1 ? this.store.totalSize - 1 : this.range.end;
			return end - start + 1;
		}
		return this.store.totalSize;
	}

	/**
	 * Get total file size.
	 */
	get totalSize(): number {
		return this.store.totalSize;
	}

	/**
	 * Get start byte for range response.
	 */
	get startByte(): number {
		return this.range?.start ?? 0;
	}

	/**
	 * Get end byte for range response.
	 */
	get endByte(): number {
		if (this.range) {
			return this.range.end === -1 ? this.store.totalSize - 1 : this.range.end;
		}
		return this.store.totalSize - 1;
	}

	/**
	 * Get stream statistics.
	 */
	get stats(): {
		bytesStreamed: number;
		currentSegment: number;
		totalSegments: number;
		cacheStats: { cached: number; maxSize: number };
		prefetchStats: { pattern: string; windowSize: number; pending: number; paused: boolean };
	} {
		return {
			bytesStreamed: this.state.bytesStreamed,
			currentSegment: this.state.currentSegmentIndex,
			totalSegments: this.file.segments.length,
			cacheStats: this.store.cacheStats,
			prefetchStats: this.prefetcher.stats
		};
	}

	/**
	 * Implement Readable._read for streaming.
	 */
	override _read(_size: number): void {
		if (this.reading || this.state.ended || this._isDestroyed) {
			return;
		}

		// Check backpressure
		if (this.readableLength > HIGH_WATER_MARK) {
			this.prefetcher.pause();
		} else {
			this.prefetcher.resume();
		}

		this.reading = true;
		this.streamNext().catch((error) => {
			this.destroy(error instanceof Error ? error : new Error(String(error)));
		});
	}

	/**
	 * Stream the next chunk of data.
	 */
	private async streamNext(): Promise<void> {
		try {
			while (!this.state.ended && !this._isDestroyed) {
				// Check if we've reached the end byte
				const currentBytePos = this.calculateCurrentBytePosition();
				if (currentBytePos > this.state.endByte) {
					this.state.ended = true;
					this.push(null);
					return;
				}

				// Get current segment data if not loaded
				if (!this.currentSegmentData) {
					if (this.state.currentSegmentIndex >= this.file.segments.length) {
						this.state.ended = true;
						this.push(null);
						return;
					}

					this.currentSegmentData = await this.prefetcher.getSegment(
						this.state.currentSegmentIndex
					);
				}

				// Calculate how much to read from current segment
				const segmentRemaining = this.currentSegmentData.length - this.state.positionInSegment;
				const bytesUntilEnd = this.state.endByte - currentBytePos + 1;
				const toRead = Math.min(segmentRemaining, bytesUntilEnd);

				if (toRead <= 0) {
					// Move to next segment
					this.state.currentSegmentIndex++;
					this.state.positionInSegment = 0;
					this.currentSegmentData = null;
					continue;
				}

				// Extract the chunk
				const chunk = this.currentSegmentData.subarray(
					this.state.positionInSegment,
					this.state.positionInSegment + toRead
				);

				this.state.positionInSegment += toRead;
				this.state.bytesStreamed += toRead;

				// Report progress
				if (this.onProgress) {
					this.onProgress(this.state.bytesStreamed, this.contentLength);
				}

				// Check if segment exhausted
				if (this.state.positionInSegment >= this.currentSegmentData.length) {
					this.state.currentSegmentIndex++;
					this.state.positionInSegment = 0;
					this.currentSegmentData = null;
				}

				// Push chunk
				const canContinue = this.push(chunk);
				if (!canContinue) {
					// Backpressure - pause and wait for _read to be called again
					this.prefetcher.pause();
					this.reading = false;
					return;
				}
			}
		} catch (error) {
			logger.error(
				{
					mountId: this.mountId,
					fileIndex: this.fileIndex,
					file: this.file.name,
					segmentIndex: this.state.currentSegmentIndex,
					bytesStreamed: this.state.bytesStreamed,
					err: error,
					error: error instanceof Error ? error.message : 'Unknown error'
				},
				'Usenet seekable stream failed while reading data'
			);
			throw error;
		} finally {
			this.reading = false;
		}
	}

	/**
	 * Calculate current byte position in the file.
	 */
	private calculateCurrentBytePosition(): number {
		const segmentOffset = this.store.getSegmentOffset(this.state.currentSegmentIndex);
		return segmentOffset + this.state.positionInSegment;
	}

	/**
	 * Override destroy to clean up resources.
	 */
	override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
		this._isDestroyed = true;
		this.prefetcher.clear();
		this.store.clearCache();
		this.currentSegmentData = null;

		logger.debug(
			{
				mountId: this.mountId,
				fileIndex: this.fileIndex,
				file: this.file.name,
				bytesStreamed: this.state.bytesStreamed,
				currentSegmentIndex: this.state.currentSegmentIndex,
				error: error?.message
			},
			'Usenet seekable stream destroyed'
		);

		callback(error);
	}
}
