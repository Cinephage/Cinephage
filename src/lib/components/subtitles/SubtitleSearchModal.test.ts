// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import SubtitleSearchModal from './SubtitleSearchModal.svelte';

const searchSubtitlesMock = vi.hoisted(() => vi.fn());
const downloadSubtitleMock = vi.hoisted(() => vi.fn());
const getSubtitleProvidersMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/api/subtitles.js', () => ({
	searchSubtitles: searchSubtitlesMock,
	downloadSubtitle: downloadSubtitleMock,
	getSubtitleProviders: getSubtitleProvidersMock
}));

const MOVIE_ID = '1a3d9ab6-9bd5-4c40-b8a5-9e035fbaeb49';
const MOVIE_FILE_A = '5e3d9ab6-9bd5-4c40-b8a5-9e035fbaeb49';
const MOVIE_FILE_B = '6e3d9ab6-9bd5-4c40-b8a5-9e035fbaeb49';

interface ResultFixture {
	providerId: string;
	providerName: string;
	providerSubtitleId: string;
	language: string;
	title: string;
	releaseName?: string;
	fileName?: string;
	isForced: boolean;
	isHearingImpaired: boolean;
	format: string;
	isHashMatch: boolean;
	matchScore: number;
	downloadUrl?: string;
	pageLink?: string;
	movieFileId?: string;
	movieFileName?: string;
}

function makeResult(overrides: Partial<ResultFixture> = {}): ResultFixture {
	return {
		providerId: 'provider-1',
		providerName: 'Provider One',
		providerSubtitleId: 'sub-1',
		language: 'en',
		title: 'Movie.2024.1080p',
		releaseName: 'Movie.2024.1080p',
		fileName: 'Movie.2024.1080p.srt',
		isForced: false,
		isHearingImpaired: false,
		format: 'srt',
		isHashMatch: false,
		matchScore: 85,
		downloadUrl: 'https://provider.test/download/1',
		pageLink: 'https://provider.test/page/1',
		...overrides
	};
}

function searchResponse(
	results: ResultFixture[],
	extra: Record<string, unknown> = {}
): Record<string, unknown> {
	return {
		results,
		totalResults: results.length,
		searchTimeMs: 12,
		languages: ['en'],
		providerResults: [],
		...extra
	};
}

function renderModal(props: Record<string, unknown> = {}) {
	return render(SubtitleSearchModal, {
		props: {
			open: true,
			title: 'Test Movie',
			movieId: MOVIE_ID,
			onClose: vi.fn(),
			...props
		}
	});
}

describe('SubtitleSearchModal', () => {
	beforeEach(() => {
		searchSubtitlesMock.mockReset();
		downloadSubtitleMock.mockReset();
		getSubtitleProvidersMock.mockReset();
		getSubtitleProvidersMock.mockResolvedValue([]);
	});

	afterEach(() => {
		cleanup();
	});

	it('renders one row per movie file when provider results collide (duplicate-key fix)', async () => {
		searchSubtitlesMock.mockResolvedValue(
			searchResponse([
				makeResult({
					movieFileId: MOVIE_FILE_A,
					movieFileName: 'Movie.2024.2160p.mkv',
					providerSubtitleId: 'shared-id'
				}),
				makeResult({
					movieFileId: MOVIE_FILE_B,
					movieFileName: 'Movie.2024.1080p.mkv',
					providerSubtitleId: 'shared-id'
				})
			])
		);

		renderModal();

		const buttons = await screen.findAllByRole('button', { name: /^download$/i });
		expect(buttons).toHaveLength(2);
		// Group headers label each originating movie file.
		expect(screen.getByText('Movie.2024.2160p.mkv')).toBeTruthy();
		expect(screen.getByText('Movie.2024.1080p.mkv')).toBeTruthy();
	});

	it('surfaces per-provider failures', async () => {
		searchSubtitlesMock.mockResolvedValue(
			searchResponse([makeResult()], {
				providerResults: [
					{
						providerId: 'broken',
						providerName: 'Broken Provider',
						resultCount: 0,
						error: 'API key invalid',
						searchTimeMs: 3
					}
				]
			})
		);

		renderModal();

		expect(await screen.findByText(/Broken Provider: API key invalid/)).toBeTruthy();
		expect(await screen.findByText(/1 provider failed/)).toBeTruthy();
	});

	it('shows the threshold message (not "No subtitles found") when results exist but none clears the profile', async () => {
		searchSubtitlesMock.mockResolvedValue(
			searchResponse([makeResult({ matchScore: 42 })], {
				bestRejectedScore: 42,
				bestRejectedReason: 'threshold',
				effectiveMinimumScore: 70
			})
		);

		renderModal();

		expect(await screen.findByText(/below threshold/i)).toBeTruthy();
		expect(screen.getByText(/best score 42/)).toBeTruthy();
		expect(screen.queryByText(/No subtitles found/i)).toBeNull();
	});

	it('reserves "No subtitles found" for zero results', async () => {
		searchSubtitlesMock.mockResolvedValue(searchResponse([]));

		renderModal();

		expect(await screen.findByText(/No subtitles found/i)).toBeTruthy();
	});

	it('submits the full selected result (including movieFileId) on download', async () => {
		downloadSubtitleMock.mockResolvedValue({
			success: true,
			subtitle: { subtitleId: 'downloaded-1', language: 'en', format: 'srt' }
		});
		searchSubtitlesMock.mockResolvedValue(
			searchResponse([
				makeResult({
					movieFileId: MOVIE_FILE_A,
					movieFileName: 'Movie.2024.2160p.mkv',
					isHashMatch: true,
					matchScore: 93
				})
			])
		);

		renderModal();

		const button = await screen.findByRole('button', { name: /^download$/i });
		await fireEvent.click(button);

		await waitFor(() => expect(downloadSubtitleMock).toHaveBeenCalledTimes(1));
		expect(downloadSubtitleMock).toHaveBeenCalledWith({
			providerId: 'provider-1',
			providerName: 'Provider One',
			providerSubtitleId: 'sub-1',
			language: 'en',
			title: 'Movie.2024.1080p',
			releaseName: 'Movie.2024.1080p',
			fileName: 'Movie.2024.1080p.srt',
			isForced: false,
			isHearingImpaired: false,
			format: 'srt',
			isHashMatch: true,
			matchScore: 93,
			downloadUrl: 'https://provider.test/download/1',
			pageLink: 'https://provider.test/page/1',
			movieFileId: MOVIE_FILE_A,
			fileSize: undefined,
			uploadDate: undefined,
			downloadCount: undefined,
			movieId: MOVIE_ID
		});
	});

	it('seeds the language filter from the effective profile returned by search', async () => {
		searchSubtitlesMock.mockResolvedValue(
			searchResponse([makeResult()], { languages: ['fr', 'en'] })
		);

		renderModal();

		await screen.findAllByRole('button', { name: /^download$/i });
		// The seeded languages are reflected as selected (primary) pills.
		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'French' }).className).toContain('btn-primary');
			expect(screen.getByRole('button', { name: 'English' }).className).toContain('btn-primary');
		});
	});
});
