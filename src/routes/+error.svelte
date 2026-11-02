<script lang="ts" module>
	import * as m from '#lib/paraglide/messages.js';

	const fallbackMessage = m.error_fallbackMessage();
</script>

<script lang="ts">
	import { page } from '$app/state';

	let { error }: { error: App.Error | undefined } = $props();
	const status = $derived(page.status);
	const message = $derived(error?.message || fallbackMessage);
	const errorId = $derived(error?.supportId ?? m.error_supportIdUnavailable());
</script>

<svelte:head>
	<title>{m.error_pageTitle({ status: String(status) })}</title>
</svelte:head>

<div class="hero min-h-screen bg-base-200">
	<div class="hero-content w-full max-w-3xl flex-col gap-6 py-16">
		<div class="alert w-fit rounded-full px-4 py-2 alert-error">
			<span class="h-2 w-2 rounded-full bg-error"></span>
			<span class="text-sm font-medium tracking-[0.18em] uppercase">
				{m.error_playbackInterrupted()}
			</span>
		</div>

		<h1 class="w-full max-w-2xl text-4xl font-semibold text-base-content sm:text-5xl">
			{message}
		</h1>

		<p class="w-full max-w-2xl text-base-content/70 sm:text-lg">
			{m.error_description()}
		</p>

		<div class="stats w-full stats-vertical shadow-sm sm:stats-horizontal">
			<div class="stat">
				<div class="stat-title text-xs tracking-[0.18em] uppercase">
					{m.error_statusLabel()}
				</div>
				<div class="stat-value text-2xl">{status}</div>
			</div>
			<div class="stat">
				<div class="stat-title text-xs tracking-[0.18em] uppercase">
					{m.error_supportIdLabel()}
				</div>
				<div class="stat-value font-mono text-sm text-error">{errorId}</div>
			</div>
		</div>

		<div class="flex flex-col gap-3 sm:flex-row">
			<a href="/" class="btn btn-primary">
				{m.error_returnHome()}
			</a>
			<button type="button" class="btn btn-outline" onclick={() => history.back()}>
				{m.error_goBack()}
			</button>
		</div>
	</div>
</div>
