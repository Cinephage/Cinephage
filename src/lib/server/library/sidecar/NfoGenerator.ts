/**
 * Kodi-compatible .nfo sidecar generation.
 */

import type { movies, series, seasons, episodes } from '#lib/server/db/schema.js';

type Movie = typeof movies.$inferSelect;
type Series = typeof series.$inferSelect;
type Season = typeof seasons.$inferSelect;
type Episode = typeof episodes.$inferSelect;

/**
 * Only the fields buildStreamDetails actually reads - both movieFiles and
 * episodeFiles rows are structurally compatible, and callers in
 * ImportService often have this before a full inserted row exists yet.
 */
export interface NfoFileInfo {
	mediaInfo?: {
		videoCodec?: string;
		width?: number;
		height?: number;
		runtime?: number;
		audioCodec?: string;
		audioChannels?: number;
		audioLanguages?: string[];
		subtitleLanguages?: string[];
	} | null;
	quality?: { codec?: string } | null;
}

// Jellyfin's own reader silently fails to apply <fileinfo>/<streamdetails> data
// (title/plot/etc still get through) without a leading UTF-8 BOM - confirmed by
// hand against a Jellyfin 12.0 instance.
const BOM = '﻿';

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function tag(name: string, value: string | number | null | undefined, attrs = ''): string {
	if (value === null || value === undefined || value === '') return '';
	const openTag = attrs ? `<${name} ${attrs}>` : `<${name}>`;
	return `\t\t${openTag}${escapeXml(String(value))}</${name}>\n`;
}

/**
 * The `fileinfo/streamdetails` block shared by movies and episodes,
 * `mediaInfo`/`quality` are real ffprobe output already extracted at import time.
 */
function buildStreamDetails(file: NfoFileInfo | null | undefined): string {
	if (!file) return '';
	const { mediaInfo, quality } = file;
	const width = mediaInfo?.width;
	const height = mediaInfo?.height;
	const aspect = width && height ? (width / height).toFixed(3) : undefined;
	const durationSeconds = mediaInfo?.runtime;

	const video =
		width || height || durationSeconds || mediaInfo?.videoCodec
			? [
					'\t\t<video>\n',
					tag('codec', mediaInfo?.videoCodec ?? quality?.codec),
					tag('aspect', aspect),
					tag('width', width),
					tag('height', height),
					tag('durationinseconds', durationSeconds),
					'\t\t</video>\n'
				].join('')
			: '';

	const audio =
		mediaInfo?.audioCodec || mediaInfo?.audioChannels
			? [
					'\t\t<audio>\n',
					tag('codec', mediaInfo?.audioCodec),
					tag('channels', mediaInfo?.audioChannels),
					tag('language', mediaInfo?.audioLanguages?.[0]),
					'\t\t</audio>\n'
				].join('')
			: '';

	const subtitles = (mediaInfo?.subtitleLanguages ?? [])
		.map((lang) => `\t\t<subtitle>\n${tag('language', lang)}\t\t</subtitle>\n`)
		.join('');

	if (!video && !audio && !subtitles) return '';

	return [
		'\t<fileinfo>\n',
		'\t<streamdetails>\n',
		video,
		audio,
		subtitles,
		'\t</streamdetails>\n',
		'\t</fileinfo>\n'
	].join('');
}

export function buildMovieNfo(
	movie: Movie,
	file: NfoFileInfo | null | undefined,
	includeArtwork = false
): string {
	const lines = [
		BOM,
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n',
		'<movie>\n',
		tag('title', movie.title),
		tag('originaltitle', movie.originalTitle),
		tag('year', movie.year),
		tag('plot', movie.overview),
		...(movie.genres ?? []).map((genre) => tag('genre', genre)),
		tag('premiered', movie.releaseDate),
		tag('runtime', movie.runtime),
		tag('tmdbid', movie.tmdbId),
		movie.tmdbId ? tag('uniqueid', movie.tmdbId, 'type="tmdb" default="true"') : '',
		movie.imdbId ? tag('uniqueid', movie.imdbId, 'type="imdb"') : '',
		movie.collectionName ? `\t\t<set>\n${tag('name', movie.collectionName)}\t\t</set>\n` : '',
		includeArtwork
			? `\t\t<art>\n${tag('poster', 'poster.jpg')}${tag('fanart', 'fanart.jpg')}\t\t</art>\n`
			: '',
		buildStreamDetails(file),
		'</movie>\n'
	];
	return lines.join('');
}

/**
 * Show-level tvshow.nfo, written once at the series root alongside
 * poster.jpg/fanart.jpg - not tied to any single video file, so no
 * fileinfo/streamdetails block (that's per-episode, via buildEpisodeNfo).
 */
export function buildSeriesNfo(seriesRow: Series, includeArtwork = false): string {
	const lines = [
		BOM,
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n',
		'<tvshow>\n',
		tag('title', seriesRow.title),
		tag('originaltitle', seriesRow.originalTitle),
		tag('year', seriesRow.year),
		tag('plot', seriesRow.overview),
		...(seriesRow.genres ?? []).map((genre) => tag('genre', genre)),
		tag('premiered', seriesRow.firstAirDate),
		tag('studio', seriesRow.network),
		tag('tmdbid', seriesRow.tmdbId),
		seriesRow.tmdbId ? tag('uniqueid', seriesRow.tmdbId, 'type="tmdb" default="true"') : '',
		seriesRow.imdbId ? tag('uniqueid', seriesRow.imdbId, 'type="imdb"') : '',
		seriesRow.tvdbId ? tag('uniqueid', seriesRow.tvdbId, 'type="tvdb"') : '',
		includeArtwork
			? `\t\t<art>\n${tag('poster', 'poster.jpg')}${tag('fanart', 'fanart.jpg')}\t\t</art>\n`
			: '',
		'</tvshow>\n'
	];
	return lines.join('');
}

/**
 * Season-level season.nfo, written inside the season's own subfolder
 * alongside the seasonNN-poster.jpg living at the series root.
 */
export function buildSeasonNfo(seasonRow: Season): string {
	const lines = [
		BOM,
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n',
		'<season>\n',
		tag('title', seasonRow.name),
		tag('seasonnumber', seasonRow.seasonNumber),
		tag('plot', seasonRow.overview),
		tag('premiered', seasonRow.airDate),
		'</season>\n'
	];
	return lines.join('');
}

/**
 * A single episode file can cover multiple episodes (double episodes,
 * season packs matched to a range).
 */
export function buildEpisodeNfo(
	seriesRow: Series,
	episodesInFile: Episode[],
	file: NfoFileInfo | null | undefined
): string {
	const blocks = episodesInFile.map((episode) =>
		[
			'<episodedetails>\n',
			tag('title', episode.title),
			tag('showtitle', seriesRow.title),
			tag('season', episode.seasonNumber),
			tag('episode', episode.episodeNumber),
			tag('aired', episode.airDate),
			tag('plot', episode.overview),
			tag('runtime', episode.runtime),
			episode.tmdbId ? tag('uniqueid', episode.tmdbId, 'type="tmdb" default="true"') : '',
			buildStreamDetails(file),
			'</episodedetails>\n'
		].join('')
	);

	return `${BOM}<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${blocks.join('')}`;
}

/** Sidecar path: same directory and base name as the media file, `.nfo` extension. */
export function nfoPathFor(mediaFilePath: string): string {
	const lastDot = mediaFilePath.lastIndexOf('.');
	const base =
		lastDot > mediaFilePath.lastIndexOf('/') ? mediaFilePath.slice(0, lastDot) : mediaFilePath;
	return `${base}.nfo`;
}
