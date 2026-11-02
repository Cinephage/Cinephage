import { basename } from 'node:path';
import { eq } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'scans' as const });
import { db } from '#lib/server/db/index.js';
import { episodeFiles, movieFiles, movies, series } from '#lib/server/db/schema.js';
import { ReleaseParser } from '#lib/server/indexers/parser/ReleaseParser.js';
import { chooseBestParsedRelease } from './naming/preview-metadata.js';

const parser = new ReleaseParser();

export interface ReleaseMetadataIssueSample {
	mediaType: 'movie' | 'episode';
	fileId: string;
	mediaId: string;
	mediaTitle: string;
	riskLevel: 'low' | 'high';
	currentRelativePath: string;
	currentFileName: string;
	sceneName?: string;
	preferredSource: 'sceneName' | 'currentFilename';
	existingEdition?: string;
	inferredEdition?: string;
	existingReleaseGroup?: string;
	inferredReleaseGroup?: string;
	issues: string[];
}

export interface ReleaseMetadataBackfillResult {
	apply: boolean;
	movieFilesScanned: number;
	episodeFilesScanned: number;
	movieFilesUpdated: number;
	episodeFilesUpdated: number;
	editionsBackfilled: number;
	releaseGroupsBackfilled: number;
	suspiciousSceneNames: number;
	issueCounts: Record<string, number>;
	highRiskCount: number;
	lowRiskCount: number;
	samples: ReleaseMetadataIssueSample[];
	errors: string[];
}

export interface ReleaseMetadataBackfillOptions {
	apply?: boolean;
	sampleLimit?: number;
}

export interface ReleaseMetadataAnalysisInput {
	currentFileName: string;
	actualTitle: string;
	actualYear?: number;
	sceneName?: string | null;
	existingEdition?: string | null;
	existingReleaseGroup?: string | null;
}

export interface ReleaseMetadataAnalysis {
	preferredSource: 'sceneName' | 'currentFilename';
	inferredEdition?: string;
	inferredReleaseGroup?: string;
	shouldBackfillEdition: boolean;
	shouldBackfillReleaseGroup: boolean;
	sceneNameLooksSuspicious: boolean;
	releaseGroupLooksSuspicious: boolean;
	riskLevel: 'low' | 'high';
	issues: string[];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function looksSuspiciousReleaseGroup(group?: string): boolean {
	if (!group) return false;
	const normalized = group.trim();
	if (!normalized) return false;
	return /^(ash|open|redemption)$/i.test(normalized);
}

function determineRiskLevel(issues: string[]): 'low' | 'high' {
	if (
		issues.includes('scene_title_mismatch') ||
		issues.includes('scene_year_mismatch') ||
		issues.includes('suspicious_release_group') ||
		issues.includes('release_group_conflict') ||
		issues.includes('edition_conflict')
	) {
		return 'high';
	}

	return 'low';
}

function normalizeTitle(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function titlesMatch(a: string, b: string): boolean {
	const left = normalizeTitle(a);
	const right = normalizeTitle(b);
	if (!left || !right) return false;
	return left === right || left.includes(right) || right.includes(left);
}

export function analyzeReleaseMetadata(
	input: ReleaseMetadataAnalysisInput
): ReleaseMetadataAnalysis {
	const preferred = chooseBestParsedRelease({
		sceneName: input.sceneName,
		currentFileName: input.currentFileName,
		actualTitle: input.actualTitle,
		actualYear: input.actualYear
	});
	const currentParsed = parser.parse(input.currentFileName);
	const sceneParsed = input.sceneName ? parser.parse(input.sceneName) : null;
	const issues: string[] = [];

	const sceneTitleMismatch = Boolean(
		sceneParsed?.cleanTitle && !titlesMatch(sceneParsed.cleanTitle, input.actualTitle)
	);
	const sceneYearMismatch = Boolean(
		sceneParsed?.year && input.actualYear && sceneParsed.year !== input.actualYear
	);
	const sceneNameLooksSuspicious = Boolean(
		input.sceneName &&
		(sceneTitleMismatch || sceneYearMismatch || preferred.label === 'currentFilename')
	);

	if (sceneTitleMismatch) issues.push('scene_title_mismatch');
	if (sceneYearMismatch) issues.push('scene_year_mismatch');
	if (input.sceneName && preferred.label === 'currentFilename')
		issues.push('prefer_current_filename');

	const editionCandidates = uniqueStrings([
		preferred.parsed.edition,
		currentParsed.edition,
		sceneParsed?.edition
	]);
	const releaseGroupCandidates = uniqueStrings([
		preferred.parsed.releaseGroup,
		currentParsed.releaseGroup,
		sceneParsed?.releaseGroup
	]);

	const inferredEdition = input.existingEdition?.trim() || editionCandidates[0];
	const inferredReleaseGroup = input.existingReleaseGroup?.trim() || releaseGroupCandidates[0];
	const releaseGroupLooksSuspicious = looksSuspiciousReleaseGroup(inferredReleaseGroup);

	const shouldBackfillEdition = !input.existingEdition && Boolean(inferredEdition);
	const shouldBackfillReleaseGroup =
		!input.existingReleaseGroup && Boolean(inferredReleaseGroup) && !releaseGroupLooksSuspicious;

	if (shouldBackfillEdition) issues.push('missing_edition');
	if (shouldBackfillReleaseGroup) issues.push('missing_release_group');
	if (releaseGroupLooksSuspicious) issues.push('suspicious_release_group');
	if (editionCandidates.length > 1) issues.push('edition_conflict');
	if (releaseGroupCandidates.length > 1) issues.push('release_group_conflict');
	const riskLevel = determineRiskLevel(issues);

	return {
		preferredSource: preferred.label,
		inferredEdition: inferredEdition || undefined,
		inferredReleaseGroup: inferredReleaseGroup || undefined,
		shouldBackfillEdition,
		shouldBackfillReleaseGroup,
		sceneNameLooksSuspicious,
		releaseGroupLooksSuspicious,
		riskLevel,
		issues
	};
}

export async function backfillReleaseMetadata(
	options: ReleaseMetadataBackfillOptions = {}
): Promise<ReleaseMetadataBackfillResult> {
	const apply = options.apply ?? false;
	const sampleLimit = options.sampleLimit ?? 50;
	const result: ReleaseMetadataBackfillResult = {
		apply,
		movieFilesScanned: 0,
		episodeFilesScanned: 0,
		movieFilesUpdated: 0,
		episodeFilesUpdated: 0,
		editionsBackfilled: 0,
		releaseGroupsBackfilled: 0,
		suspiciousSceneNames: 0,
		issueCounts: {},
		highRiskCount: 0,
		lowRiskCount: 0,
		samples: [],
		errors: []
	};

	const allMovies = await db
		.select({ id: movies.id, title: movies.title, year: movies.year })
		.from(movies);
	const movieMap = new Map(allMovies.map((movie) => [movie.id, movie]));
	const allSeries = await db
		.select({ id: series.id, title: series.title, year: series.year })
		.from(series);
	const seriesMap = new Map(allSeries.map((show) => [show.id, show]));

	const movieRows = await db
		.select({
			id: movieFiles.id,
			movieId: movieFiles.movieId,
			relativePath: movieFiles.relativePath,
			sceneName: movieFiles.sceneName,
			edition: movieFiles.edition,
			releaseGroup: movieFiles.releaseGroup
		})
		.from(movieFiles);

	for (const row of movieRows) {
		result.movieFilesScanned++;
		const movie = movieMap.get(row.movieId);
		if (!movie) continue;

		try {
			const currentFileName = basename(row.relativePath);
			const analysis = analyzeReleaseMetadata({
				currentFileName,
				actualTitle: movie.title,
				actualYear: movie.year ?? undefined,
				sceneName: row.sceneName,
				existingEdition: row.edition,
				existingReleaseGroup: row.releaseGroup
			});

			if (analysis.sceneNameLooksSuspicious) result.suspiciousSceneNames++;
			if (analysis.riskLevel === 'high') result.highRiskCount++;
			else result.lowRiskCount++;
			for (const issue of analysis.issues) {
				result.issueCounts[issue] = (result.issueCounts[issue] ?? 0) + 1;
			}

			if (analysis.issues.length > 0 && result.samples.length < sampleLimit) {
				result.samples.push({
					mediaType: 'movie',
					fileId: row.id,
					mediaId: row.movieId,
					mediaTitle: movie.title,
					riskLevel: analysis.riskLevel,
					currentRelativePath: row.relativePath,
					currentFileName,
					sceneName: row.sceneName ?? undefined,
					preferredSource: analysis.preferredSource,
					existingEdition: row.edition ?? undefined,
					inferredEdition: analysis.inferredEdition,
					existingReleaseGroup: row.releaseGroup ?? undefined,
					inferredReleaseGroup: analysis.inferredReleaseGroup,
					issues: analysis.issues
				});
			}

			if (apply && (analysis.shouldBackfillEdition || analysis.shouldBackfillReleaseGroup)) {
				await db
					.update(movieFiles)
					.set({
						edition: analysis.shouldBackfillEdition ? analysis.inferredEdition : row.edition,
						releaseGroup: analysis.shouldBackfillReleaseGroup
							? analysis.inferredReleaseGroup
							: row.releaseGroup
					})
					.where(eq(movieFiles.id, row.id));

				result.movieFilesUpdated++;
				if (analysis.shouldBackfillEdition) result.editionsBackfilled++;
				if (analysis.shouldBackfillReleaseGroup) result.releaseGroupsBackfilled++;
			}
		} catch (error) {
			result.errors.push(
				`movie:${row.id}:${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	const episodeRows = await db
		.select({
			id: episodeFiles.id,
			seriesId: episodeFiles.seriesId,
			relativePath: episodeFiles.relativePath,
			sceneName: episodeFiles.sceneName,
			edition: episodeFiles.edition,
			releaseGroup: episodeFiles.releaseGroup
		})
		.from(episodeFiles);

	for (const row of episodeRows) {
		result.episodeFilesScanned++;
		const show = seriesMap.get(row.seriesId);
		if (!show) continue;

		try {
			const currentFileName = basename(row.relativePath);
			const analysis = analyzeReleaseMetadata({
				currentFileName,
				actualTitle: show.title,
				actualYear: show.year ?? undefined,
				sceneName: row.sceneName,
				existingEdition: row.edition,
				existingReleaseGroup: row.releaseGroup
			});

			if (analysis.sceneNameLooksSuspicious) result.suspiciousSceneNames++;
			if (analysis.riskLevel === 'high') result.highRiskCount++;
			else result.lowRiskCount++;
			for (const issue of analysis.issues) {
				result.issueCounts[issue] = (result.issueCounts[issue] ?? 0) + 1;
			}

			if (analysis.issues.length > 0 && result.samples.length < sampleLimit) {
				result.samples.push({
					mediaType: 'episode',
					fileId: row.id,
					mediaId: row.seriesId,
					mediaTitle: show.title,
					riskLevel: analysis.riskLevel,
					currentRelativePath: row.relativePath,
					currentFileName,
					sceneName: row.sceneName ?? undefined,
					preferredSource: analysis.preferredSource,
					existingEdition: row.edition ?? undefined,
					inferredEdition: analysis.inferredEdition,
					existingReleaseGroup: row.releaseGroup ?? undefined,
					inferredReleaseGroup: analysis.inferredReleaseGroup,
					issues: analysis.issues
				});
			}

			if (apply && (analysis.shouldBackfillEdition || analysis.shouldBackfillReleaseGroup)) {
				await db
					.update(episodeFiles)
					.set({
						edition: analysis.shouldBackfillEdition ? analysis.inferredEdition : row.edition,
						releaseGroup: analysis.shouldBackfillReleaseGroup
							? analysis.inferredReleaseGroup
							: row.releaseGroup
					})
					.where(eq(episodeFiles.id, row.id));

				result.episodeFilesUpdated++;
				if (analysis.shouldBackfillEdition) result.editionsBackfilled++;
				if (analysis.shouldBackfillReleaseGroup) result.releaseGroupsBackfilled++;
			}
		} catch (error) {
			result.errors.push(
				`episode:${row.id}:${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	logger.info(
		{
			apply,
			movieFilesScanned: result.movieFilesScanned,
			episodeFilesScanned: result.episodeFilesScanned,
			movieFilesUpdated: result.movieFilesUpdated,
			episodeFilesUpdated: result.episodeFilesUpdated,
			editionsBackfilled: result.editionsBackfilled,
			releaseGroupsBackfilled: result.releaseGroupsBackfilled,
			suspiciousSceneNames: result.suspiciousSceneNames,
			highRiskCount: result.highRiskCount,
			lowRiskCount: result.lowRiskCount,
			errors: result.errors.length
		},
		'[ReleaseMetadataBackfill] Completed'
	);

	return result;
}
