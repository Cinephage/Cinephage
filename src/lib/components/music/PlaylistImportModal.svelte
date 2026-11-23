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
		phase: 'fetching' | 'resolving' | 'ready' | 'importing' | 'done' | 'failed' | 'cancelled';
		progress: { done: number; total: number };
		playlist: { title: string; owner: string | null; trackCount: number; provider: string } | null;
		trackTotal: number;
		resolvedTracks: number;
		rows: JobRow[];
		unmatched: Array<{ title: string; artist: string | null; reason: string }>;
		summary: { added: number; existing: number; failed: number } | null;
		error: string | null;
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
			if (job.phase === 'done') onDone?.();
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
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			submitting = false;
		}
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
					searchAfterAdd
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

	{#if error}
		<div class="alert alert-error mt-4 py-2 text-sm">{error}</div>
	{/if}

	{#if job && job.phase !== 'failed' && job.phase !== 'cancelled'}
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
					<p class="mt-1 text-xs text-warning">
						{m.music_importUnmatchedSummary({ count: job.unmatched.length })}
					</p>
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
	{:else if job && (job.phase === 'failed' || job.phase === 'cancelled')}
		<div class="mt-4 space-y-3">
			<div class="alert alert-error py-2 text-sm">
				{job.error ?? m.music_importFailedTitle()}
			</div>
			<div class="flex justify-end">
				<button class="btn btn-ghost btn-sm" onclick={() => void start()}>
					{m.music_importRetry()}
				</button>
			</div>
		</div>
	{/if}
</ModalWrapper>
