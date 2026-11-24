<script lang="ts">
	/**
	 * Paste a playlist, review what it resolves to, add the albums.
	 *
	 * The server owns both slow halves (reading the playlist, matching it
	 * against MusicBrainz), so this component is a poller and a checklist: it
	 * never guesses a match and never adds something the user did not tick.
	 */
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { ModalWrapper } from '#lib/components/ui/modal/index.js';
	import { ListMusic } from '@lucide/svelte';

	interface JobRow {
		releaseGroupMbid: string;
		title: string;
		artistName: string;
		year: number | null;
		primaryType: string | null;
		matchedBy: 'album' | 'track';
		confidence: 'high' | 'low';
		tracks: Array<{ title: string; artist: string }>;
		inLibrary: boolean;
		albumId: string | null;
		status: 'pending' | 'added' | 'existing' | 'failed' | 'skipped';
		error: string | null;
	}

	interface Job {
		id: string;
		phase:
			| 'fetching'
			| 'resolving'
			| 'ready'
			| 'importing'
			| 'done'
			| 'failed'
			| 'cancelled'
			| 'interrupted';
		progress: { done: number; total: number };
		playlist: { title: string; owner: string | null; trackCount: number; provider: string } | null;
		trackTotal: number;
		resolvedTracks: number;
		rows: JobRow[];
		unmatched: Array<{ title: string; artist: string | null; reason: string }>;
		summary: { added: number; existing: number; failed: number } | null;
		error: string | null;
		url: string;
		createdAt: string;
	}

	let { open, onClose, onDone }: { open: boolean; onClose: () => void; onDone?: () => void } =
		$props();

	let url = $state('');
	let job = $state<Job | null>(null);
	let error = $state<string | null>(null);
	let submitting = $state(false);
	/** Selected release-group mbids; a Set so re-resolving never keeps a stale id. */
	let selected = $state<Set<string>>(new Set());
	let hideInLibrary = $state(true);
	let profiles = $state<Array<{ id: string; name: string }>>([]);
	let defaultProfileName = $state<string | null>(null);
	let profileId = $state('');
	let monitored = $state(true);
	let searchAfterAdd = $state(false);
	/** 'album' adds what matched; 'artist' adds each match's discography. */
	let scope = $state<'album' | 'artist' | 'features' | 'songs'>('album');
	/** What the artist/features scopes would add, asked for before importing. */
	let expansion = $state<{
		total: number;
		byArtist: Array<{
			artistName: string;
			count: number;
			albums: Array<{ title: string; year: number | null }>;
		}>;
	} | null>(null);
	let expanding = $state(false);
	let expansionKey = '';
	let recent = $state<Job[]>([]);
	let timer: ReturnType<typeof setTimeout> | null = null;

	const busy = $derived(
		job?.phase === 'fetching' || job?.phase === 'resolving' || job?.phase === 'importing'
	);
	const visibleRows = $derived((job?.rows ?? []).filter((row) => !hideInLibrary || !row.inLibrary));
	const selectableRows = $derived(visibleRows.filter((row) => row.status === 'pending'));
	const allSelected = $derived(
		selectableRows.length > 0 && selectableRows.every((row) => selected.has(row.releaseGroupMbid))
	);

	function stopPolling() {
		if (timer) clearTimeout(timer);
		timer = null;
	}

	function schedule(jobId: string) {
		stopPolling();
		timer = setTimeout(() => void poll(jobId), 1200);
	}

	async function poll(jobId: string) {
		try {
			const response = await fetch(`/api/music/playlists/jobs/${jobId}`);
			const body = (await response.json()) as { job?: Job; error?: string };
			if (!response.ok || !body.job) {
				error = body.error ?? m.music_importFailedTitle();
				return;
			}
			job = body.job;
			if (job.phase === 'fetching' || job.phase === 'resolving' || job.phase === 'importing') {
				schedule(jobId);
				return;
			}
			if (job.phase === 'ready' && selected.size === 0) {
				// Pre-tick everything new; the whole point of the paste is to add
				// the library, and an album already there needs no tick.
				selected = new Set(
					job.rows.filter((row) => !row.inLibrary).map((row) => row.releaseGroupMbid)
				);
			}
			if (job.phase === 'done') {
				void loadRecent();
				onDone?.();
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
	}

	async function start() {
		stopPolling();
		submitting = true;
		error = null;
		job = null;
		selected = new Set();
		try {
			const response = await fetch('/api/music/playlists/jobs', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url })
			});
			const body = (await response.json()) as { job?: Job; error?: string };
			if (!response.ok || !body.job) {
				error = body.error ?? m.music_importFailedTitle();
				return;
			}
			job = body.job;
			schedule(body.job.id);
			void loadRecent();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			submitting = false;
		}
	}

	/**
	 * Ask what "artist" would add before it is added.
	 *
	 * Three checked albums can be two hundred; the server computes the same
	 * expansion the import will run, from the same cache, so this is a count
	 * rather than a guess.
	 */
	async function loadExpansion() {
		if (!job || (scope !== 'artist' && scope !== 'features') || selected.size === 0) {
			expansion = null;
			expansionKey = '';
			return;
		}
		const key = `${job.id}|${scope}|${[...selected].sort().join(',')}`;
		if (key === expansionKey) return;
		expansionKey = key;
		expanding = true;
		try {
			const response = await fetch(`/api/music/playlists/jobs/${job.id}/expand`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ rowIds: [...selected], scope })
			});
			const body = (await response.json()) as {
				total?: number;
				byArtist?: Array<{
					artistName: string;
					count: number;
					albums: Array<{ title: string; year: number | null }>;
				}>;
			};
			expansion = response.ok
				? { total: body.total ?? 0, byArtist: body.byArtist ?? [] }
				: null;
		} catch {
			expansion = null;
		} finally {
			expanding = false;
		}
	}

	$effect(() => {
		// Re-ask whenever the selection or the scope changes, not on every tick.
		if (job?.phase === 'ready') void loadExpansion();
	});

	/** The list a returning user sees: what ran, how it ended, what can resume. */
	async function loadRecent() {
		try {
			const response = await fetch('/api/music/playlists/jobs?limit=10');
			if (!response.ok) return;
			const body = (await response.json()) as { jobs?: Job[] };
			recent = body.jobs ?? [];
		} catch {
			recent = [];
		}
	}

	async function resume(id: string) {
		error = null;
		try {
			const response = await fetch(`/api/music/playlists/jobs/${id}/resume`, { method: 'POST' });
			const body = (await response.json()) as { job?: Job; error?: string };
			if (!response.ok || !body.job) {
				error = body.error ?? m.music_importFailedTitle();
				return;
			}
			job = body.job;
			schedule(body.job.id);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
	}

	/** A finished job's per-album outcome, kept in the row so a user can review it later. */
	function statusLabel(entry: Job): string {
		if (entry.phase === 'done') return m.music_importStatusDone();
		if (entry.phase === 'failed') return m.music_importStatusFailed();
		if (entry.phase === 'interrupted') return m.music_importInterrupted();
		if (entry.phase === 'ready') return m.music_importStatusReady();
		return m.music_importStatusRunning();
	}

	async function importSelected() {
		if (!job || selected.size === 0) return;
		error = null;
		try {
			const response = await fetch(`/api/music/playlists/jobs/${job.id}/import`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					rowIds: [...selected],
					qualityProfileId: profileId || null,
					monitored,
					searchAfterAdd,
					scope
				})
			});
			const body = (await response.json()) as { job?: Job; error?: string };
			if (!response.ok || !body.job) {
				error = body.error ?? m.music_importFailedTitle();
				return;
			}
			job = body.job;
			schedule(job.id);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
	}

	function toggle(id: string) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}

	function toggleAll() {
		selected = allSelected ? new Set() : new Set(selectableRows.map((row) => row.releaseGroupMbid));
	}

	// A closed modal starts clean; the job itself lives on the server.
	$effect(() => {
		if (open) void loadRecent();
		if (!open) {
			stopPolling();
			job = null;
			error = null;
			url = '';
			selected = new Set();
		}
	});

	onMount(() => {
		void (async () => {
			try {
				const [profileResponse, settingsResponse] = await Promise.all([
					fetch('/api/scoring-profiles?mediaKind=music'),
					fetch('/api/music/settings')
				]);
				const profileBody = profileResponse.ok
					? ((await profileResponse.json()) as { profiles?: Array<{ id: string; name: string }> })
					: null;
				const settingsBody = settingsResponse.ok
					? ((await settingsResponse.json()) as {
							defaultProfileId?: string | null;
							effectiveProfile?: { name: string } | null;
						})
					: null;
				profiles = (profileBody?.profiles ?? []).map((profile) => ({
					id: profile.id,
					name: profile.name
				}));
				defaultProfileName = settingsBody?.effectiveProfile?.name ?? null;
			} catch {
				profiles = [];
			}
		})();
		return stopPolling;
	});
</script>

<ModalWrapper {open} {onClose} maxWidth="3xl" labelledBy="music-playlist-import-title" flexContent>
	<div class="flex items-start justify-between gap-4">
		<div class="flex min-w-0 items-start gap-3">
			<div class="mt-0.5 rounded-lg bg-primary/15 p-2 text-primary">
				<ListMusic class="h-4 w-4" />
			</div>
			<div class="min-w-0">
				<h3 id="music-playlist-import-title" class="text-lg font-semibold">
					{m.music_importPlaylist()}
				</h3>
				<p class="mt-1 text-sm text-base-content/60">{m.music_importPlaylistHint()}</p>
			</div>
		</div>
		<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose} aria-label={m.action_close()}>
			✕
		</button>
	</div>

	<div class="mt-4 flex gap-2">
		<input
			class="input input-bordered input-sm w-full"
			type="url"
			placeholder="https://…"
			bind:value={url}
			disabled={busy || submitting}
			onkeydown={(event) => {
				if (event.key === 'Enter' && url.trim()) void start();
			}}
		/>
		<button
			class="btn btn-primary btn-sm shrink-0"
			disabled={!url.trim() || busy || submitting}
			onclick={() => void start()}
		>
			{m.music_importReadPlaylist()}
		</button>
	</div>

	<div class="mt-3 flex flex-wrap items-center gap-2">
		<span class="text-xs font-medium text-base-content/70">{m.music_importScope()}</span>
		<select class="select select-bordered select-xs" bind:value={scope}>
			<option value="album">{m.music_importScopeAlbum()}</option>
			<option value="artist">{m.music_importScopeArtist()}</option>
			<option value="features">{m.music_importScopeFeatures()}</option>
			<option value="songs">{m.music_importScopeSongs()}</option>
		</select>
		<span class="text-xs text-base-content/50">
			{scope === 'artist'
				? m.music_importScopeHint()
				: scope === 'features'
					? m.music_importScopeFeaturesHint()
					: scope === 'songs'
						? m.music_importScopeSongsHint()
						: ''}
		</span>
	</div>

	{#if (scope === 'artist' || scope === 'features') && (expanding || expansion)}
		<div class="mt-1 text-xs text-base-content/60">
			{#if expanding && !expansion}
				<span class="loading loading-spinner loading-xs"></span>
			{:else if expansion}
				<span>{m.music_importExpandSummary({ count: expansion.total })}</span>
				{#if expansion.total > 0}
					<details class="mt-0.5">
						<summary class="cursor-pointer text-base-content/45">
							{m.music_importExpandShow()}
						</summary>
						<ul class="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
							{#each expansion.byArtist as artist (artist.artistName)}
								<li>
									<span class="font-medium">{artist.artistName}</span>
									<span class="text-base-content/45">+{artist.count}</span>
									{#if artist.count > 0}
										<span class="text-base-content/40">
											— {artist.albums
												.slice(0, 4)
												.map((album) => album.title)
												.join(', ')}{artist.count > 4 ? '…' : ''}
										</span>
									{/if}
								</li>
							{/each}
						</ul>
					</details>
				{/if}
			{/if}
		</div>
	{/if}

	{#if error}
		<div class="alert alert-error mt-4 py-2 text-sm">{error}</div>
	{/if}

	{#if !job && recent.length > 0}
		<div class="mt-5">
			<h4 class="text-sm font-semibold">{m.music_importRecent()}</h4>
			<ul class="mt-2 divide-y divide-base-200 text-sm">
				{#each recent as entry (entry.id)}
					<li class="flex items-center gap-3 py-2">
						<span class="min-w-0 flex-1 truncate text-base-content/70">{entry.url}</span>
						<span
							class="badge badge-xs {entry.phase === 'done'
								? 'badge-success'
								: entry.phase === 'interrupted' || entry.phase === 'failed'
									? 'badge-warning'
									: 'badge-ghost'}"
						>
							{statusLabel(entry)}
						</span>
						{#if entry.summary}
							<span class="text-xs text-base-content/50">
								{entry.summary.added} / {entry.summary.existing} / {entry.summary.failed}
							</span>
						{/if}
						{#if entry.phase === 'interrupted' || entry.phase === 'failed'}
							<button class="btn btn-ghost btn-xs" onclick={() => void resume(entry.id)}>
								{m.music_importResume()}
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if job && job.phase !== 'failed' && job.phase !== 'cancelled' && job.phase !== 'interrupted'}
		<div class="mt-5 min-h-0 flex-1 overflow-y-auto">
			{#if job.playlist}
				<div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
					<span class="font-semibold">{job.playlist.title}</span>
					{#if job.playlist.owner}
						<span class="text-base-content/50">· {job.playlist.owner}</span>
					{/if}
					<span class="text-base-content/50">
						· {m.music_importResolvedSummary({
							albums: job.rows.length,
							tracks: job.trackTotal
						})}
					</span>
				</div>
				{#if job.unmatched.length > 0}
					<details class="mt-1 text-xs text-warning">
						<summary class="cursor-pointer">
							{m.music_importUnmatchedBroken({
								count: job.unmatched.length,
								unreachable: job.unmatched.filter((entry) => entry.reason === 'lookup-failed').length,
								noMatch: job.unmatched.filter((entry) => entry.reason !== 'lookup-failed').length
							})}
						</summary>
						<ul class="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-base-content/70">
							{#each job.unmatched as entry, index (index)}
								<li class="truncate">
									{entry.artist ? `${entry.artist} — ` : ''}{entry.title}
								</li>
							{/each}
						</ul>
					</details>
				{/if}
			{/if}

			{#if busy}
				<div class="mt-4 space-y-2">
					<p class="flex items-center gap-2 text-sm text-base-content/70">
						<span class="loading loading-spinner loading-xs"></span>
						{job.phase === 'fetching'
							? m.music_importReadingPlaylist()
							: job.phase === 'resolving'
								? m.music_importResolving()
								: m.music_importImporting()}
					</p>
					{#if job.progress.total > 0}
						<progress
							class="progress progress-primary w-full"
							value={job.progress.done}
							max={job.progress.total}
						></progress>
						<p class="text-xs text-base-content/50">
							{job.progress.done} / {job.progress.total}
						</p>
					{/if}
				</div>
			{/if}

			{#if job.rows.length > 0}
				<div class="mt-4 flex flex-wrap items-center gap-3 text-xs">
					<label class="flex cursor-pointer items-center gap-1.5">
						<input
							type="checkbox"
							class="checkbox checkbox-xs"
							checked={allSelected}
							disabled={job.phase !== 'ready'}
							onchange={toggleAll}
						/>
						{m.music_importSelectAll()}
					</label>
					<label class="flex cursor-pointer items-center gap-1.5">
						<input type="checkbox" class="checkbox checkbox-xs" bind:checked={hideInLibrary} />
						{m.music_importHideInLibrary()}
					</label>
					<span class="ml-auto text-base-content/50">
						{selected.size} / {job.rows.length}
					</span>
				</div>

				<div class="mt-2 overflow-x-auto rounded-lg border border-base-300">
					<table class="table table-sm">
						<thead class="bg-base-200/60 text-xs">
							<tr>
								<th class="w-8"></th>
								<th>{m.music_importAlbumColumn()}</th>
								<th>{m.music_importArtistColumn()}</th>
								<th class="w-20">{m.music_importMatchColumn()}</th>
								<th class="w-24 text-right">{m.music_importSongsColumn()}</th>
								<th class="w-24"></th>
							</tr>
						</thead>
						<tbody>
							{#each visibleRows as row (row.releaseGroupMbid)}
								<tr class={row.status === 'failed' ? 'bg-error/10' : ''}>
									<td>
										<input
											type="checkbox"
											class="checkbox checkbox-xs"
											checked={selected.has(row.releaseGroupMbid)}
											disabled={job.phase !== 'ready' || row.status !== 'pending'}
											onchange={() => toggle(row.releaseGroupMbid)}
										/>
									</td>
									<td>
										<div class="font-medium">{row.title}</div>
										<div class="text-xs text-base-content/50">
											{row.primaryType ?? ''}{row.year ? ` · ${row.year}` : ''}
										</div>
									</td>
									<td class="text-sm">{row.artistName}</td>
									<td>
										<span
											class="badge badge-xs {row.matchedBy === 'album'
												? 'badge-ghost'
												: 'badge-warning'}"
											title={row.matchedBy === 'album'
												? m.music_importMatchedByAlbum()
												: m.music_importMatchedByTrack()}
										>
											{row.matchedBy === 'album'
												? m.music_importMatchedByAlbum()
												: m.music_importMatchedByTrack()}
										</span>
									</td>
									<td class="text-right text-xs text-base-content/60">{row.tracks.length}</td>
									<td class="text-right">
										{#if row.status === 'added'}
											<span class="badge badge-success badge-sm">{m.music_importAdded()}</span>
										{:else if row.status === 'existing'}
											<span class="badge badge-ghost badge-sm">{m.music_importInLibrary()}</span>
										{:else if row.status === 'failed'}
											<span class="badge badge-error badge-sm" title={row.error ?? ''}>
												{m.music_importRowFailed()}
											</span>
										{:else if row.inLibrary}
											<span class="badge badge-ghost badge-sm">{m.music_importInLibrary()}</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			{#if job.phase === 'ready' && job.rows.length === 0}
				<p class="mt-4 text-sm text-base-content/60">{m.music_importNoMatches()}</p>
			{/if}

			{#if job.phase === 'ready'}
				<div class="mt-4 grid gap-3 sm:grid-cols-2">
					<label class="form-control">
						<span class="mb-1 text-xs font-medium">{m.common_qualityProfile()}</span>
						<select class="select select-bordered select-sm" bind:value={profileId}>
							<option value="">
								{defaultProfileName
									? m.music_useDefaultProfile({ name: defaultProfileName })
									: m.common_default()}
							</option>
							{#each profiles as profile (profile.id)}
								<option value={profile.id}>{profile.name}</option>
							{/each}
						</select>
					</label>
					<div class="flex flex-col justify-end gap-1 text-xs">
						<label class="flex cursor-pointer items-center gap-1.5">
							<input type="checkbox" class="checkbox checkbox-xs" bind:checked={monitored} />
							{m.music_importMonitorAdded()}
						</label>
						<label class="flex cursor-pointer items-center gap-1.5">
							<input type="checkbox" class="checkbox checkbox-xs" bind:checked={searchAfterAdd} />
							{m.music_importSearchAfterAdd()}
						</label>
					</div>
				</div>
			{/if}

			{#if job.phase === 'done' && job.summary}
				<div class="alert alert-success mt-4 py-2 text-sm">
					{m.music_importSummary({
						added: job.summary.added,
						existing: job.summary.existing,
						failed: job.summary.failed
					})}
				</div>
			{/if}
		</div>

		<div class="mt-4 flex justify-end gap-2">
			<button class="btn btn-ghost btn-sm" onclick={onClose}>
				{job.phase === 'done' ? m.action_close() : m.action_cancel()}
			</button>
			{#if job.phase === 'ready'}
				<button
					class="btn btn-primary btn-sm"
					disabled={selected.size === 0}
					onclick={() => void importSelected()}
				>
					{m.music_importAddSelected({ count: selected.size })}
				</button>
			{/if}
		</div>
	{:else if job && (job.phase === 'failed' || job.phase === 'cancelled' || job.phase === 'interrupted')}
		{@const finishedId = job.id}
		<div class="mt-4 space-y-3">
			<div class="alert {job.phase === 'interrupted' ? 'alert-warning' : 'alert-error'} py-2 text-sm">
				{job.phase === 'interrupted' ? m.music_importInterruptedHint() : (job.error ?? m.music_importFailedTitle())}
			</div>
			<div class="flex justify-end gap-2">
				{#if job.phase === 'interrupted'}
					<button class="btn btn-primary btn-sm" onclick={() => void resume(finishedId)}>
						{m.music_importResume()}
					</button>
				{:else}
					<button class="btn btn-ghost btn-sm" onclick={() => void start()}>
						{m.music_importRetry()}
					</button>
				{/if}
			</div>
		</div>
	{/if}
</ModalWrapper>
