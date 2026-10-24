import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, chmod, stat, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairRootFolderPermissions } from './permission-repair.js';

describe('repairRootFolderPermissions', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'cinephage-permission-repair-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	const fakeRoot = (path: string) => ({ id: 'root-1', name: 'Movies', path, readOnly: false });

	async function addDir(path: string, mode: number) {
		await mkdir(path);
		await chmod(path, mode);
	}

	async function addFile(path: string, mode: number) {
		await writeFile(path, 'x');
		await chmod(path, mode);
	}

	it('fixes umask-truncated (0700/0600) entries and leaves every other mode alone', async () => {
		const broken = join(tmpDir, 'Broken');
		const season = join(broken, 'Season 1');
		await addDir(broken, 0o700);
		await addDir(season, 0o700);
		await addFile(join(season, 'ep.mkv'), 0o600);
		await addFile(join(season, 'ep.srt'), 0o600);

		const fine = join(tmpDir, 'Fine');
		await addDir(fine, 0o755);
		await addFile(join(fine, 'ok.mkv'), 0o644);

		const deliberate = join(tmpDir, 'Deliberate');
		await addDir(deliberate, 0o750);
		await addFile(join(deliberate, 'shared.mkv'), 0o640);

		const summary = await repairRootFolderPermissions(fakeRoot(tmpDir));

		expect(summary.dirsFixed).toBe(2);
		expect(summary.filesFixed).toBe(2);
		expect(summary.errors).toEqual([]);
		expect((await stat(broken)).mode & 0o777).toBe(0o755);
		expect((await stat(season)).mode & 0o777).toBe(0o755);
		expect((await stat(join(season, 'ep.mkv'))).mode & 0o777).toBe(0o644);
		expect((await stat(join(season, 'ep.srt'))).mode & 0o777).toBe(0o644);
		// Deliberately group-accessible modes are never touched.
		expect((await stat(deliberate)).mode & 0o777).toBe(0o750);
		expect((await stat(join(deliberate, 'shared.mkv'))).mode & 0o777).toBe(0o640);
	});

	it('repairs the contents of the root but never the root folder itself', async () => {
		const root = join(tmpDir, 'root');
		await addDir(root, 0o700);
		await addFile(join(root, 'a.mkv'), 0o600);

		const summary = await repairRootFolderPermissions(fakeRoot(root));

		expect(summary.filesFixed).toBe(1);
		expect((await stat(root)).mode & 0o777).toBe(0o700);
		expect((await stat(join(root, 'a.mkv'))).mode & 0o777).toBe(0o644);
	});

	it('does not follow symlinks that lead outside the root', async () => {
		const outside = join(tmpDir, 'outside');
		await addDir(outside, 0o700);
		await addFile(join(outside, 'secret.mkv'), 0o600);

		const root = join(tmpDir, 'root');
		await addDir(root, 0o700);
		await symlink(outside, join(root, 'escape'));

		const summary = await repairRootFolderPermissions(fakeRoot(root));

		expect((await lstat(join(root, 'escape'))).isSymbolicLink()).toBe(true);
		// Nothing beyond the symlink was traversed or chmodded.
		expect((await stat(join(outside, 'secret.mkv'))).mode & 0o777).toBe(0o600);
		expect(summary.filesFixed).toBe(0);
	});

	it('skips read-only roots entirely', async () => {
		const root = join(tmpDir, 'ro');
		await addDir(root, 0o700);
		await addFile(join(root, 'a.mkv'), 0o600);

		const summary = await repairRootFolderPermissions({
			id: 'root-ro',
			name: 'Catalogue',
			path: root,
			readOnly: true
		});

		expect(summary.roots).toHaveLength(1);
		expect(summary.roots[0].skipped).toBe(true);
		expect(summary.roots[0].skipReason).toBe('Read-only root folder');
		expect((await stat(join(root, 'a.mkv'))).mode & 0o777).toBe(0o600);
		expect(summary.filesFixed).toBe(0);
	});

	it('reports an inaccessible root as skipped instead of throwing', async () => {
		const summary = await repairRootFolderPermissions(fakeRoot(join(tmpDir, 'missing')));

		expect(summary.roots).toHaveLength(1);
		expect(summary.roots[0].skipped).toBe(true);
		expect(summary.roots[0].skipReason).toContain('not accessible');
	});
});
