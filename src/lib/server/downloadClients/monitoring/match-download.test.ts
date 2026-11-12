/**
 * The matching rules the monitor applies between a queue row and a client
 * download, exercised without a database.
 */
import { describe, it, expect } from 'vitest';
import type { DownloadInfo } from '../core/interfaces';
import {
	identityUpdateFor,
	indexDownloadsByHash,
	matchQueueItem,
	type QueueIdentity
} from './match-download';

function download(overrides: Partial<DownloadInfo> = {}): DownloadInfo {
	return {
		id: 'client-id',
		name: 'Some.Release.1080p',
		hash: 'aaaa1111',
		progress: 0.5,
		status: 'downloading',
		size: 1,
		downloadSpeed: 0,
		uploadSpeed: 0,
		savePath: '/downloads',
		contentPath: '/downloads/some',
		canMoveFiles: false,
		canBeRemoved: false,
		...overrides
	};
}

function row(overrides: Partial<QueueIdentity> = {}): QueueIdentity {
	return {
		downloadId: 'bbbb2222',
		infoHash: null,
		magnetUrl: null,
		title: 'Some.Release.1080p',
		...overrides
	};
}

const noTitle: { allowTitleFallback: false } = { allowTitleFallback: false };

describe('matchQueueItem', () => {
	it('matches on the stored client id first', () => {
		const downloads = [download(), download({ hash: 'cccc3333', name: 'Other' })];
		const match = matchQueueItem(
			row({ downloadId: 'aaaa1111' }),
			indexDownloadsByHash(downloads),
			downloads,
			noTitle
		);
		expect(match?.matchedBy).toBe('downloadId');
		expect(match?.download.hash).toBe('aaaa1111');
	});

	it('falls back to the stored infoHash', () => {
		const downloads = [download()];
		const match = matchQueueItem(
			row({ downloadId: 'gone', infoHash: 'AAAA1111' }),
			indexDownloadsByHash(downloads),
			downloads,
			noTitle
		);
		expect(match?.matchedBy).toBe('infoHash');
	});

	it('falls back to the hash inside the magnet', () => {
		const fullHash = 'a'.repeat(40);
		const downloads = [download({ hash: fullHash })];
		const match = matchQueueItem(
			row({ downloadId: 'gone', magnetUrl: `magnet:?xt=urn:btih:${fullHash}&dn=Some.Release` }),
			indexDownloadsByHash(downloads),
			downloads,
			noTitle
		);
		expect(match?.matchedBy).toBe('magnetUrl');
	});

	it('matches by title only when the caller allows it', () => {
		const downloads = [download()];
		const item = row({ downloadId: 'gone' });

		expect(matchQueueItem(item, indexDownloadsByHash(downloads), downloads, noTitle)).toBeNull();
		expect(
			matchQueueItem(item, indexDownloadsByHash(downloads), downloads, {
				allowTitleFallback: true
			})?.matchedBy
		).toBe('title');
	});

	it('refuses to guess when two client jobs share the title', () => {
		// Binding an arbitrary one is how two queue rows ended up owning one job.
		const downloads = [
			download({ hash: 'aaaa1111' }),
			download({ hash: 'dddd4444', id: 'client-id-2' })
		];
		const match = matchQueueItem(
			row({ downloadId: 'gone' }),
			indexDownloadsByHash(downloads),
			downloads,
			{ allowTitleFallback: true }
		);
		expect(match).toBeNull();
	});

	it('never takes an item another row already holds by id', () => {
		const downloads = [download()];
		const match = matchQueueItem(
			row({ downloadId: 'gone' }),
			indexDownloadsByHash(downloads),
			downloads,
			{ allowTitleFallback: true, claimed: new Set(['aaaa1111']) }
		);
		expect(match).toBeNull();
	});
});

describe('identityUpdateFor', () => {
	it('leaves an exact match alone', () => {
		const downloads = [download()];
		const match = matchQueueItem(
			row({ downloadId: 'aaaa1111' }),
			indexDownloadsByHash(downloads),
			downloads,
			noTitle
		);
		expect(match).not.toBeNull();
		expect(identityUpdateFor(match!, 'usenet')).toBeNull();
	});

	it('adopts the client id but never writes it into infoHash for usenet', () => {
		const downloads = [download()];
		const match = matchQueueItem(
			row({ downloadId: 'gone' }),
			indexDownloadsByHash(downloads),
			downloads,
			{ allowTitleFallback: true }
		);
		expect(identityUpdateFor(match!, 'usenet')).toEqual({
			downloadId: 'aaaa1111',
			infoHash: null
		});
	});

	it('keeps the hash as infoHash for torrents, where the hash is the infoHash', () => {
		const downloads = [download()];
		const match = matchQueueItem(
			row({ downloadId: 'gone' }),
			indexDownloadsByHash(downloads),
			downloads,
			{ allowTitleFallback: true }
		);
		expect(identityUpdateFor(match!, 'torrent')).toEqual({
			downloadId: 'aaaa1111',
			infoHash: 'aaaa1111'
		});
	});
});
