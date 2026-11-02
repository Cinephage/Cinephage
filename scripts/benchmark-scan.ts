/**
 * Benchmark: Large Library Scan + Reconciliation
 *
 * Purpose:
 *   Measures scan performance and event-loop responsiveness against a synthetic
 *   library of configurable size. Run this before/after changes to disk-scan.ts,
 *   ReconciliationService.ts, or db/index.ts to catch regressions on large libraries.
 *
 *   It creates a temporary fixture directory and an isolated SQLite database so
 *   the production database is never touched. Both are deleted after the run
 *   unless --keep is passed.
 *
 * Usage:
 *   npx tsx scripts/benchmark-scan.ts [options]
 *
 * Options:
 *   --files N      Total number of files/items (default: 63000)
 *   --tv           TV-only mode: generate a series tree only (scan mode)
 *   --movie        Movie-only mode: generate a flat movie tree only (scan mode)
 *   --reconcile    Reconcile benchmark: seed DB rows and run ReconciliationService
 *   --keep         Skip cleanup: leave fixture dirs and temp DB for inspection
 *
 * Example runs (scan benchmark):
 *   npx tsx scripts/benchmark-scan.ts --files 63000            # mixed (default)
 *   npx tsx scripts/benchmark-scan.ts --files 63000 --tv       # TV only
 *   npx tsx scripts/benchmark-scan.ts --files 63000 --movie    # movies only
 *
 * Example runs (reconcile benchmark):
 *   npx tsx scripts/benchmark-scan.ts --reconcile              # 63000 items (~31k movies + ~31k TV files)
 *   npx tsx scripts/benchmark-scan.ts --reconcile --files 100000
 *
 * Output (scan):
 *   - Fixture generation time
 *   - Per-scan wall-clock time and file counts
 *   - Event loop lag across all scans (p50 / p99 / max)
 *   - DB size after all scans and after incremental_vacuum
 *
 * Output (reconcile):
 *   - Seeding time
 *   - Three passes: insert-only, update-only, partial-insert
 *   - Per-pass wall-clock time + event-loop lag (p50 / p99 / max)
 *   - Item counts per pass (inserted / updated / deleted)
 *   - DB size after all passes
 *
 * Notes:
 *   - Generated scan files are empty .strm stubs; they pass the size filter because
 *     disk-scan.ts exempts .strm files from the minimum size check.
 *
 *   - What IS benchmarked by the scan mode:
 *       The full filesystem walk + DB insert path. Every generated file is
 *       discovered, parsed, and written to unmatched_files. This covers the
 *       hot path in DiskScanService and the setImmediate yield points.
 *
 *   - What IS benchmarked by --reconcile:
 *       The full ReconciliationService.reconcile() path: loading all local rows,
 *       chunked upsert transactions, stale cleanup, and event-loop yield behavior.
 *       Three passes exercise the insert path (cold start), the update path
 *       (steady state), and a mixed insert+update path (post-import trigger).
 *
 *   - What is NOT benchmarked by scan mode (DiskScanService's file-presence reconcile):
 *       After the walk, scanRootFolder calls reconcileMoviePresence /
 *       reconcileEpisodePresence to sync movies.hasFile and episodes.hasFile.
 *       It is a no-op here because no movies/series rows exist in the temp DB;
 *       those reconcile methods only update rows for matched media.
 *
 *       To benchmark DiskScanService's file-presence reconcile (a separate code
 *       path from ReconciliationService), do the following manually:
 *         1. Run the scan benchmark with --keep to preserve files and the temp DB:
 *                npx tsx scripts/benchmark-scan.ts --files 63000 --keep
 *         2. Note the fixture dir and temp DB paths printed in the header.
 *         3. Using sqlite3, insert rows into the movies table (+ movie_files for
 *            the movie root folder) or the series / seasons / episodes /
 *            episode_files tables (for the TV root folder) whose paths match the
 *            generated fixture filenames.
 *         4. Re-run the scan against the same temp DB by temporarily hardcoding
 *            DATA_DIR to the preserved data dir and the root folder ID.
 *       DiskScanService's reconcile will then find real rows to process and
 *       will exercise the bulk hasFile update transactions in disk-scan.ts.
 *
 *       Note: this is distinct from ReconciliationService.reconcile() (tested
 *       by --reconcile), which syncs the storage_items table rather than the
 *       hasFile flags on movies/episodes.
 */

import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

const { values: argv } = parseArgs({
	options: {
		files: { type: 'string', default: '63000' },
		tv: { type: 'boolean', default: false },
		movie: { type: 'boolean', default: false },
		reconcile: { type: 'boolean', default: false },
		keep: { type: 'boolean', default: false }
	}
});

const fileCount = parseInt(argv.files as string, 10);
const isTV = argv.tv as boolean;
const isMovie = argv.movie as boolean;
const isMix = !isTV && !isMovie;
const isReconcile = argv.reconcile as boolean;
const keep = argv.keep as boolean;

if (isNaN(fileCount) || fileCount < 1) {
	console.error('--files must be a positive integer');
	process.exit(1);
}
if (isTV && isMovie) {
	console.error('--tv and --movie are mutually exclusive');
	process.exit(1);
}
if (isReconcile && (isTV || isMovie)) {
	console.error('--reconcile cannot be combined with --tv or --movie');
	process.exit(1);
}

const runId = Date.now();
const movieFixtureDir = join(tmpdir(), `cinephage-bench-movies-${runId}`);
const tvFixtureDir = join(tmpdir(), `cinephage-bench-tv-${runId}`);
const fixtureDir = join(tmpdir(), `cinephage-bench-fixture-${runId}`);
const dataDir = join(tmpdir(), `cinephage-bench-data-${runId}`);

// Set DATA_DIR before importing any #lib module so the DB connection
// points at our temp directory, not the production database.
// Silence pino so benchmark output is not drowned in JSON log lines.
process.env.DATA_DIR = dataDir;
process.env.LOG_LEVEL = 'silent';

const { initializeDatabase, sqlite } = await import('../src/lib/server/db/index.js');
const { db } = await import('../src/lib/server/db/index.js');
const { rootFolders, movies, movieFiles, series, episodeFiles } =
	await import('../src/lib/server/db/schema.js');
const { diskScanService } = await import('../src/lib/server/library/disk-scan.js');
const { getReconciliationService } =
	await import('../src/lib/server/storage/reconciliation/ReconciliationService.js');

// ---------------------------------------------------------------------------
// Fixture generation (scan mode)
// ---------------------------------------------------------------------------

async function generateMovieFixtures(dir: string, count: number): Promise<void> {
	await mkdir(dir, { recursive: true });
	for (let i = 0; i < count; i++) {
		const year = 1980 + (i % 45);
		const title = `Benchmark Movie ${i + 1} (${year})`;
		const movieDir = join(dir, title);
		await mkdir(movieDir, { recursive: true });
		await writeFile(join(movieDir, `${title}.strm`), `http://benchmark/movie/${i}`);
	}
}

async function generateTvFixtures(dir: string, count: number): Promise<void> {
	await mkdir(dir, { recursive: true });
	const episodesPerSeason = 24;
	const seasonsPerSeries = 5;
	let generated = 0;
	let seriesIndex = 0;

	while (generated < count) {
		const seriesTitle = `Benchmark Series ${++seriesIndex}`;
		for (let season = 1; season <= seasonsPerSeries && generated < count; season++) {
			const seasonDir = join(dir, seriesTitle, `Season ${String(season).padStart(2, '0')}`);
			await mkdir(seasonDir, { recursive: true });
			for (let ep = 1; ep <= episodesPerSeason && generated < count; ep++) {
				const s = String(season).padStart(2, '0');
				const e = String(ep).padStart(2, '0');
				const name = `${seriesTitle} - S${s}E${e}.strm`;
				await writeFile(
					join(seasonDir, name),
					`http://benchmark/tv/${seriesIndex}/${season}/${ep}`
				);
				generated++;
			}
		}
	}
}

// ---------------------------------------------------------------------------
// DB seeding (reconcile mode)
// ---------------------------------------------------------------------------

const SEED_BATCH = 100; // rows per transaction — stays well within SQLite's variable limit
const FIXED_DATE = new Date().toISOString();
const EPISODES_PER_SERIES = 50;

function seedMoviesSync(count: number, startIdx: number = 0): void {
	for (let i = startIdx; i < startIdx + count; i += SEED_BATCH) {
		const end = Math.min(i + SEED_BATCH, startIdx + count);
		db.transaction((tx) => {
			for (let j = i; j < end; j++) {
				const movieId = randomUUID();
				tx.insert(movies)
					.values({
						id: movieId,
						tmdbId: 1_000_000 + j,
						title: `Benchmark Movie ${j}`,
						path: `/bench/movies/movie-${j}`
					})
					.run();
				tx.insert(movieFiles)
					.values({
						movieId,
						relativePath: `movie-${j}.mkv`,
						dateAdded: FIXED_DATE
					})
					.run();
			}
		});
	}
}

function seedSeriesSync(tvFileCount: number, startFileIdx: number = 0): void {
	const seriesNeeded = Math.ceil(tvFileCount / EPISODES_PER_SERIES);
	let fileIdx = startFileIdx;

	for (let s = 0; s < seriesNeeded && fileIdx < startFileIdx + tvFileCount; s++) {
		const seriesId = randomUUID();
		const globalSeriesIdx = Math.floor(startFileIdx / EPISODES_PER_SERIES) + s;
		db.transaction((tx) => {
			tx.insert(series)
				.values({
					id: seriesId,
					tmdbId: 2_000_000 + globalSeriesIdx,
					title: `Benchmark Series ${globalSeriesIdx}`,
					path: `/bench/tv/series-${globalSeriesIdx}`
				})
				.run();
			for (
				let ep = 0;
				ep < EPISODES_PER_SERIES && fileIdx < startFileIdx + tvFileCount;
				ep++, fileIdx++
			) {
				tx.insert(episodeFiles)
					.values({
						seriesId,
						seasonNumber: Math.floor(ep / 24) + 1,
						// Empty episodeIds → file-granularity fallback in loadLocalRows;
						// no episodes table rows needed, which keeps seeding fast.
						episodeIds: [] as string[],
						relativePath: `series-${globalSeriesIdx}-ep-${ep}.mkv`,
						dateAdded: FIXED_DATE
					})
					.run();
			}
		});
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fmtSize = (bytes: number) =>
	bytes >= 1024 * 1024
		? `${(bytes / 1024 / 1024).toFixed(1)} MB`
		: `${(bytes / 1024).toFixed(0)} KB`;

interface ScanSummary {
	label: string;
	durationMs: number;
	filesAdded: number;
	filesUnmatched: number;
	error?: string;
}

async function runScan(rootFolderId: string, label: string): Promise<ScanSummary> {
	console.log(`\n[${label}] Scan started...`);
	const start = Date.now();
	const result = await diskScanService.scanRootFolder(rootFolderId);
	return {
		label,
		durationMs: Date.now() - start,
		filesAdded: result.filesAdded,
		filesUnmatched: result.unmatchedFiles,
		error: result.success ? undefined : result.error
	};
}

interface ReconcileSummary {
	label: string;
	durationMs: number;
	itemsInserted: number;
	itemsUpdated: number;
	itemsDeleted: number;
	linksUpserted: number;
	errorCount: number;
	p50Ms: number;
	p99Ms: number;
	maxMs: number;
}

async function runReconcile(label: string): Promise<ReconcileSummary> {
	process.stdout.write(`\n[${label}] Reconcile started...`);
	const histogram = monitorEventLoopDelay({ resolution: 10 });
	histogram.enable();
	const result = await getReconciliationService().reconcile();
	histogram.disable();
	process.stdout.write(` done (${(result.durationMs / 1000).toFixed(1)}s)\n`);
	return {
		label,
		durationMs: result.durationMs,
		itemsInserted: result.itemsInserted,
		itemsUpdated: result.itemsUpdated,
		itemsDeleted: result.itemsDeleted,
		linksUpserted: result.linksUpserted,
		errorCount: result.errorCount,
		p50Ms: Math.round(histogram.percentile(50) / 1e6),
		p99Ms: Math.round(histogram.percentile(99) / 1e6),
		maxMs: Math.round(histogram.max / 1e6)
	};
}

// ---------------------------------------------------------------------------
// Main — reconcile benchmark
// ---------------------------------------------------------------------------

if (isReconcile) {
	const movieCount = Math.floor(fileCount / 2);
	const tvCount = fileCount - movieCount;
	const extraMovies = Math.floor(movieCount * 0.1);
	const extraTv = Math.floor(tvCount * 0.1);
	const extraTotal = extraMovies + extraTv;

	console.log('\nCinephage Reconcile Benchmark');
	console.log('-'.repeat(56));
	console.log(
		`Items:       ${fileCount.toLocaleString()} (${movieCount.toLocaleString()} movies + ${tvCount.toLocaleString()} TV files)`
	);
	console.log(
		`Extra (pass 3): ${extraTotal.toLocaleString()} (${extraMovies.toLocaleString()} movies + ${extraTv.toLocaleString()} TV files)`
	);
	console.log(`Keep files:  ${keep}`);
	console.log(`Temp DB:     ${dataDir}/cinephage.db`);
	console.log('-'.repeat(56));

	process.stdout.write('\nInitializing temp database... ');
	await initializeDatabase();
	console.log('done');

	process.stdout.write(
		`Seeding ${movieCount.toLocaleString()} movies + ${tvCount.toLocaleString()} TV episode files... `
	);
	const seedStart = Date.now();
	seedMoviesSync(movieCount);
	seedSeriesSync(tvCount);
	console.log(`done (${((Date.now() - seedStart) / 1000).toFixed(1)}s)`);

	// Pass 1: all inserts (cold start — storageItems is empty)
	const pass1 = await runReconcile('Pass 1 - insert');

	// Pass 2: all updates (steady state — every key already exists)
	const pass2 = await runReconcile('Pass 2 - update');

	// Pass 3: seed 10% more items, then reconcile (mix of inserts + updates)
	process.stdout.write(`\nSeeding ${extraTotal.toLocaleString()} additional items (10%)... `);
	const extra2Start = Date.now();
	seedMoviesSync(extraMovies, movieCount);
	seedSeriesSync(extraTv, tvCount);
	console.log(`done (${((Date.now() - extra2Start) / 1000).toFixed(1)}s)`);

	const pass3 = await runReconcile('Pass 3 - partial insert');

	// Results
	const dbPath = join(dataDir, 'cinephage.db');
	const sizeBefore = (await stat(dbPath)).size;
	sqlite.pragma('incremental_vacuum');
	const sizeAfter = (await stat(dbPath)).size;

	console.log('\nResults');
	console.log('-'.repeat(56));
	for (const s of [pass1, pass2, pass3]) {
		console.log(`\n[${s.label}]`);
		console.log(`  Duration:       ${(s.durationMs / 1000).toFixed(2)}s`);
		console.log(`  Event loop lag: p50 ${s.p50Ms}ms  p99 ${s.p99Ms}ms  max ${s.maxMs}ms`);
		console.log(
			`  Items:          ${s.itemsInserted} inserted  ${s.itemsUpdated} updated  ${s.itemsDeleted} deleted  ${s.linksUpserted} links`
		);
		if (s.errorCount > 0) console.log(`  [WARN] ${s.errorCount} item errors`);
	}
	console.log(`\nDB size after reconcile:  ${fmtSize(sizeBefore)}`);
	console.log(`DB size after vacuum:     ${fmtSize(sizeAfter)}`);
	console.log('-'.repeat(56));

	if (!keep) {
		process.stdout.write('\nCleaning up temp DB... ');
		await rm(dataDir, { recursive: true, force: true });
		console.log('done');
	} else {
		console.log('\n--keep passed: temp DB left for inspection.');
	}

	console.log();
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Main — scan benchmark
// ---------------------------------------------------------------------------

const mode = isMix ? 'Mix (movies + TV)' : isTV ? 'TV only' : 'Movies only';
const movieCount = isMix ? Math.floor(fileCount / 2) : isMovie ? fileCount : 0;
const tvCount = isMix ? fileCount - movieCount : isTV ? fileCount : 0;

console.log('\nCinephage Scan Benchmark');
console.log('-'.repeat(48));
console.log(`Files:       ${fileCount.toLocaleString()} (${mode})`);
if (isMix) {
	console.log(`  Movies:    ${movieCount.toLocaleString()}`);
	console.log(`  TV eps:    ${tvCount.toLocaleString()}`);
}
console.log(`Keep files:  ${keep}`);
console.log(`Temp DB:     ${dataDir}/cinephage.db`);
console.log('-'.repeat(48));

// 1. Generate fixtures
process.stdout.write(`\nGenerating ${fileCount.toLocaleString()} fixture files... `);
const genStart = Date.now();
if (isMix) {
	await generateMovieFixtures(movieFixtureDir, movieCount);
	await generateTvFixtures(tvFixtureDir, tvCount);
} else if (isTV) {
	await generateTvFixtures(fixtureDir, tvCount);
} else {
	await generateMovieFixtures(fixtureDir, movieCount);
}
console.log(`done (${((Date.now() - genStart) / 1000).toFixed(1)}s)`);

// 2. Initialize fresh DB
process.stdout.write('Initializing temp database... ');
await initializeDatabase();
console.log('done');

// 3. Insert root folder(s)
const rootFolderValues = isMix
	? [
			{ name: 'Benchmark Movies', path: movieFixtureDir, mediaType: 'movie' as const },
			{ name: 'Benchmark TV', path: tvFixtureDir, mediaType: 'tv' as const }
		]
	: [
			{
				name: 'Benchmark Library',
				path: fixtureDir,
				mediaType: (isTV ? 'tv' : 'movie') as 'tv' | 'movie'
			}
		];

const insertedFolders = await db.insert(rootFolders).values(rootFolderValues).returning();

// 4. Start event-loop lag monitor (spans all scans)
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();

// 5. Run scan(s)
const summaries: ScanSummary[] = [];
for (const folder of insertedFolders) {
	const label = folder.mediaType === 'movie' ? 'Movies' : 'TV';
	summaries.push(await runScan(folder.id, label));
}

histogram.disable();

// 6. DB size before and after incremental_vacuum
const dbPath = join(dataDir, 'cinephage.db');
const sizeBefore = (await stat(dbPath)).size;
sqlite.pragma('incremental_vacuum');
const sizeAfter = (await stat(dbPath)).size;

// 7. Print results
const totalMs = summaries.reduce((s, r) => s + r.durationMs, 0);
const p50 = Math.round(histogram.percentile(50) / 1e6);
const p99 = Math.round(histogram.percentile(99) / 1e6);
const maxLag = Math.round(histogram.max / 1e6);

console.log('\nResults');
console.log('─'.repeat(48));
for (const s of summaries) {
	console.log(`[${s.label}] scan time: ${(s.durationMs / 1000).toFixed(1)}s`);
	console.log(
		`         added: ${s.filesAdded.toLocaleString()}  unmatched: ${s.filesUnmatched.toLocaleString()}`
	);
	if (s.error) console.log(`         [WARN] ${s.error}`);
}
if (summaries.length > 1) {
	console.log(`Total scan time:    ${(totalMs / 1000).toFixed(1)}s`);
}
console.log(`\nEvent loop lag (across all scans):`);
console.log(`  p50: ${p50}ms   p99: ${p99}ms   max: ${maxLag}ms`);
console.log(`\nDB size after scan:    ${fmtSize(sizeBefore)}`);
console.log(`DB size after vacuum:  ${fmtSize(sizeAfter)}`);
console.log('-'.repeat(48));

// 8. Cleanup
const dirsToRemove = isMix ? [movieFixtureDir, tvFixtureDir] : [fixtureDir];
if (!keep) {
	process.stdout.write('\nCleaning up fixture and temp DB... ');
	await Promise.all(dirsToRemove.map((d) => rm(d, { recursive: true, force: true })));
	await rm(dataDir, { recursive: true, force: true });
	console.log('done');
} else {
	console.log('\n--keep passed: fixture dirs and DB left for inspection.');
}

console.log();
