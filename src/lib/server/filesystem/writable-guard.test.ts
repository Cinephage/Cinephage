import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface RootRow {
	id: string;
	name: string;
	path: string;
	readOnly: boolean;
}

const rows: RootRow[] = [];

vi.mock('#lib/server/db/index.js', () => ({
	db: {
		select: () => ({
			from: () => ({
				// Drizzle's builder is thenable; emulate that.
				then: (resolve: (rows: RootRow[]) => void, reject: (err: unknown) => void) =>
					Promise.resolve([...rows]).then(resolve, reject)
			})
		})
	}
}));

import { checkDestinationWritable } from './writable-guard.js';

/**
 * The read-only destination guard is the boundary for catalogue-only mounts
 * (NZBDav, rclone remotes). Imports, debrid finalisation, .strm creation,
 * sidecar regeneration and subtitle sync all funnel through it now.
 */
describe('checkDestinationWritable', () => {
	let writableRoot: string;
	let readOnlyRoot: string;

	beforeEach(async () => {
		writableRoot = await mkdtemp(join(tmpdir(), 'cine-writable-'));
		readOnlyRoot = await mkdtemp(join(tmpdir(), 'cine-readonly-'));
		await mkdir(join(writableRoot, 'A Movie (2024)'), { recursive: true });
		await mkdir(join(readOnlyRoot, 'B Movie (2024)'), { recursive: true });
		await writeFile(join(writableRoot, 'A Movie (2024)', 'a.mkv'), 'x');
		await writeFile(join(readOnlyRoot, 'B Movie (2024)', 'b.mkv'), 'x');

		rows.length = 0;
		rows.push(
			{ id: 'w1', name: 'Writable', path: writableRoot, readOnly: false },
			{ id: 'r1', name: 'Catalogue', path: readOnlyRoot, readOnly: true }
		);
	});

	afterEach(async () => {
		const { rm } = await import('node:fs/promises');
		await rm(writableRoot, { recursive: true, force: true });
		await rm(readOnlyRoot, { recursive: true, force: true });
	});

	it('allows a path inside a writable root', async () => {
		const check = await checkDestinationWritable(join(writableRoot, 'A Movie (2024)', 'a.mkv'));
		expect(check.writable).toBe(true);
		expect(check.rootFolderId).toBe('w1');
	});

	it('rejects a path inside a read-only root, naming the folder', async () => {
		const check = await checkDestinationWritable(join(readOnlyRoot, 'B Movie (2024)', 'b.mkv'));
		expect(check.writable).toBe(false);
		expect(check.reason).toContain('Catalogue');
	});

	it('allows a path inside no managed root (containment is the caller job)', async () => {
		// Debrid materialization validates containment against its own known
		// root; this guard only answers the read-only question.
		const check = await checkDestinationWritable('/tmp/somewhere-else/movie.mkv');
		expect(check.writable).toBe(true);
		expect(check.rootFolderId).toBeUndefined();
	});

	it('treats a sibling prefix path as outside the root', async () => {
		// '/cine-writable-2' must not pass the '/cine-writable-1' prefix check.
		const check = await checkDestinationWritable(`${writableRoot}-evil/movie.mkv`);
		expect(check.writable).toBe(true); // outside both roots → not this guard's call
		expect(check.rootFolderId).toBeUndefined();
	});
});
