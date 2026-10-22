import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard: runtime data must never enter the Docker build context.
 *
 * The database holds password hashes, raw session tokens and credential
 * ciphertext; logs can hold streaming API keys; backups are full DB copies.
 * `data/*.db` was not enough: Docker's ignore matching does not let `*` cross
 * a `/`, so `data/test/*.db`, `data/backups/**\/*.db` and `data/logs/*.jsonl`
 * all slipped into the image via `COPY data ./data`.
 *
 * This emulates Docker's matcher (Go filepath.Match: `*` stays within one path
 * segment) and its last-match-wins rule for `!` re-includes.
 */
function parseDockerignore(source: string): string[] {
	return source
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** Go filepath.Match: `*` does not cross `/`, `**` is treated as `*` by Docker. */
function matchesPattern(pattern: string, path: string): boolean {
	const re = pattern
		.split('*')
		.map((part) => part.split('?').join('[^/]'))
		.join('[^/]*');
	return new RegExp(`^${re}$`).test(path);
}

/**
 * Docker excludes everything under an excluded directory, and a re-include
 * only applies if every ancestor directory was also re-included. Modelling
 * that: a path is ignored if it or any ancestor matches an exclude rule with
 * no later re-include covering it.
 */
function isIgnored(rules: string[], path: string): boolean {
	const segments = path.split('/');
	let ignored = false;

	// Walk the path from the root down; each directory inherits its parent's
	// state and can be re-included or re-excluded on its own.
	for (let i = 1; i <= segments.length; i += 1) {
		const candidate = segments.slice(0, i).join('/');
		for (const rule of rules) {
			const negated = rule.startsWith('!');
			const pattern = negated ? rule.slice(1) : rule;
			if (matchesPattern(pattern, candidate)) {
				ignored = !negated;
			}
		}
	}

	return ignored;
}

describe('docker build context', () => {
	const rules = parseDockerignore(readFileSync(join(process.cwd(), '.dockerignore'), 'utf8'));

	it.each([
		['data/cinephage.db', 'the live database'],
		['data/cinephage.db-wal', 'the database WAL'],
		['data/auth.db', 'the auth database'],
		['data/test/cinephage.db', 'the seeded test database'],
		['data/backups/scheduled/cinephage-backup.db', 'a scheduled DB backup'],
		['data/backups/pre-update/cinephage.db', 'a pre-update DB backup'],
		['data/logs/app-2026-10-22.jsonl', 'persisted logs'],
		['data/reports/report.html', 'generated reports'],
		['data/probe-env.ts', 'a stray developer scratch file'],
		['data/indexers/definitions/custom/mine.yaml', 'user-defined indexers']
	])('excludes %s (%s)', (path) => {
		expect(isIgnored(rules, path)).toBe(true);
	});

	it.each([
		['data/indexers/definitions/1337x.yaml', 'bundled indexer definitions'],
		['data/external-lists/presets/imdb-list.yaml', 'bundled list presets']
	])('keeps %s (%s) so the image can ship it', (path) => {
		expect(isIgnored(rules, path)).toBe(false);
	});
});
