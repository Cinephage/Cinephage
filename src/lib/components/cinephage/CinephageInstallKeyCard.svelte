<script lang="ts">
	import { untrack } from 'svelte';
	import { Loader2, Check, KeyRound, TriangleAlert } from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import {
		registerCinephageInstall,
		revokeCinephageInstall,
		updateCinephageConfig,
		ApiError
	} from '#lib/api/index.js';

	interface Props {
		/** Install-key state slice from the page server load (never contains the key itself). */
		installKey: {
			installId: string | null;
			registered: boolean;
			keyPrefix: string | null;
			registrationEmail: string | null;
		};
		/** Called after any successful mutation so the page can reload server data. */
		onChanged: () => Promise<void> | void;
	}

	let { installKey, onChanged }: Props = $props();

	// untrack prevents Svelte from treating installKey reads as reactive dependencies
	// inside $state() initializers. The $effect below re-syncs on data changes.
	let keyEmail = $state(untrack(() => installKey.registrationEmail ?? ''));
	$effect(() => {
		keyEmail = installKey.registrationEmail ?? '';
	});

	let registering = $state(false);
	let revoking = $state(false);
	let revealedKey = $state<string | null>(null);
	let manualKey = $state('');
	let keyCopied = $state(false);
	let confirmRotateOpen = $state(false);
	let confirmRevokeOpen = $state(false);

	// Rotation without a stored attribution email (manual-key recovery path)
	// has nothing to register with.
	const canRotate = $derived(
		!installKey.registered || Boolean(keyEmail.trim()) || Boolean(installKey.registrationEmail)
	);

	async function handleRegisterKey() {
		registering = true;
		revealedKey = null;
		keyCopied = false;
		try {
			const res = await registerCinephageInstall({ email: keyEmail });
			if (res.success && res.key) {
				revealedKey = res.key;
				toasts.add({
					message: res.rotated
						? m.settings_cinephage_installKey_rotated()
						: m.settings_cinephage_installKey_registered(),
					type: 'success'
				});
				await onChanged();
			} else {
				toasts.add({
					message: res.error || m.settings_cinephage_installKey_rateLimited(),
					type: 'error'
				});
			}
		} catch (err) {
			toasts.add({
				message:
					err instanceof ApiError
						? err.message
						: m.settings_cinephage_installKey_registrationFailed(),
				type: 'error'
			});
		} finally {
			registering = false;
		}
	}

	function requestRotate() {
		confirmRotateOpen = false;
		void handleRegisterKey();
	}

	function requestRevoke() {
		confirmRevokeOpen = false;
		void handleRevokeKey();
	}

	async function handleRevokeKey() {
		revoking = true;
		try {
			const res = await revokeCinephageInstall();
			if (res.success) {
				toasts.add({ message: m.settings_cinephage_installKey_revoked(), type: 'success' });
				revealedKey = null;
				await onChanged();
			} else {
				toasts.add({
					message: res.error || m.settings_cinephage_installKey_revokeFailed(),
					type: 'error'
				});
			}
		} catch (err) {
			toasts.add({
				message:
					err instanceof ApiError ? err.message : m.settings_cinephage_installKey_revokeFailed(),
				type: 'error'
			});
		} finally {
			revoking = false;
		}
	}

	async function handleSaveManualKey() {
		if (!manualKey.trim()) return;
		try {
			await updateCinephageConfig({ apiKey: manualKey.trim() });
			manualKey = '';
			toasts.add({ message: m.settings_cinephage_installKey_saved(), type: 'success' });
			await onChanged();
		} catch (err) {
			toasts.add({
				message:
					err instanceof ApiError ? err.message : m.settings_cinephage_installKey_saveFailed(),
				type: 'error'
			});
		}
	}

	async function copyRevealedKey() {
		if (!revealedKey) return;
		try {
			await navigator.clipboard.writeText(revealedKey);
			keyCopied = true;
		} catch {
			/* clipboard unavailable; the key remains selectable on screen */
		}
	}
</script>

<div class="rounded-2xl border border-base-300 bg-base-100 p-6 shadow-sm">
	{#if installKey.registered}
		<!-- Registered: calm credential card -->
		<div class="flex items-center justify-between gap-2">
			<h2 class="text-sm font-medium text-base-content/60">
				{m.settings_cinephage_installKey_heading()}
			</h2>
			<span class="badge gap-1 badge-sm badge-success">
				{m.settings_cinephage_installKey_registeredAs()}
			</span>
		</div>

		<p class="mt-3 font-mono text-2xl font-semibold tracking-tight">
			{#if installKey.keyPrefix}
				{installKey.keyPrefix}…
			{:else}
				ck_…
			{/if}
		</p>

		<dl class="mt-4 space-y-1.5 text-sm">
			{#if installKey.registrationEmail}
				<div class="flex flex-wrap gap-x-2">
					<dt class="text-base-content/50">{m.settings_cinephage_installKey_email()}:</dt>
					<dd>{installKey.registrationEmail}</dd>
				</div>
			{/if}
			{#if installKey.installId}
				<div class="flex flex-wrap gap-x-2">
					<dt class="text-base-content/50">{m.settings_cinephage_installKey_installId()}:</dt>
					<dd class="font-mono text-xs leading-5">{installKey.installId}</dd>
				</div>
			{/if}
		</dl>

		<div class="mt-5 flex items-center justify-end gap-1">
			<button
				class="btn btn-ghost btn-sm"
				onclick={() => (confirmRotateOpen = true)}
				disabled={registering || !canRotate}
				title={m.settings_cinephage_installKey_rotate()}
			>
				{#if registering}
					<Loader2 class="h-3 w-3 animate-spin" />
				{/if}
				{m.settings_cinephage_installKey_rotate()}
			</button>
			<button
				class="btn btn-ghost text-error btn-sm"
				onclick={() => (confirmRevokeOpen = true)}
				disabled={revoking}
			>
				{m.settings_cinephage_installKey_revoke()}
			</button>
		</div>
	{:else}
		<!-- Unregistered: the old build-auth way is going away — say so, loudly -->
		<div role="alert" class="alert items-start text-sm alert-warning">
			<TriangleAlert class="h-4 w-4 shrink-0" />
			<div>
				<p class="font-medium">{m.settings_cinephage_migrationTitle()}</p>
				<p class="text-xs opacity-80">{m.settings_cinephage_migrationMessage()}</p>
			</div>
		</div>

		<!-- Unregistered: centered call to action -->
		<div class="flex flex-col items-center gap-2 py-4 text-center">
			<div class="rounded-full bg-primary/10 p-3 text-primary">
				<KeyRound class="h-6 w-6" />
			</div>
			<h2 class="text-lg font-semibold">{m.settings_cinephage_installKey_heading()}</h2>
			<p class="max-w-sm text-sm text-base-content/60">
				{m.settings_cinephage_installKey_description()}
			</p>
		</div>
		<div class="mx-auto flex w-full max-w-sm flex-col gap-3 pb-2">
			<label class="form-control">
				<span class="label-text text-sm">{m.settings_cinephage_installKey_email()}</span>
				<input
					type="email"
					class="input-bordered input w-full"
					placeholder="admin@example.com"
					bind:value={keyEmail}
				/>
				<span class="label-text-alt text-base-content/50">
					{m.settings_cinephage_installKey_emailHint()}
				</span>
			</label>
			<button
				class="btn btn-primary"
				onclick={handleRegisterKey}
				disabled={registering || !keyEmail.includes('@')}
			>
				{#if registering}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<KeyRound class="h-4 w-4" />
				{/if}
				{m.settings_cinephage_installKey_register()}
			</button>
		</div>
	{/if}

	{#if revealedKey}
		<div role="alert" class="mt-4 alert items-start text-sm alert-warning">
			<TriangleAlert class="h-4 w-4 shrink-0" />
			<div class="min-w-0 flex-1">
				<p class="text-xs">{m.settings_cinephage_installKey_shownOnce()}</p>
				<div class="mt-2 flex items-center gap-2">
					<code class="flex-1 overflow-x-auto rounded bg-base-300 px-2 py-1 font-mono text-sm">
						{revealedKey}
					</code>
					<button class="btn btn-sm" onclick={copyRevealedKey}>
						{#if keyCopied}
							<Check class="h-3 w-3" />
							{m.settings_cinephage_copied()}
						{:else}
							{m.settings_cinephage_installKey_copy()}
						{/if}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<details class="mt-3">
		<summary class="cursor-pointer text-xs font-medium text-base-content/50">
			{m.settings_cinephage_installKey_manual()}
		</summary>
		<div class="mt-2 space-y-2">
			<p class="text-xs text-base-content/50">{m.settings_cinephage_installKey_manualHint()}</p>
			<div class="flex flex-wrap items-end gap-2">
				<label class="form-control w-full max-w-xs">
					<input
						type="password"
						class="input-bordered input w-full font-mono input-sm"
						placeholder="ck_…"
						bind:value={manualKey}
						autocomplete="off"
					/>
				</label>
				<button class="btn btn-outline btn-sm" onclick={handleSaveManualKey}>
					{m.settings_cinephage_saveSettings()}
				</button>
			</div>
		</div>
	</details>
</div>

<ConfirmationModal
	open={confirmRotateOpen}
	title={m.settings_cinephage_installKey_rotateConfirmTitle()}
	message={m.settings_cinephage_installKey_rotateConfirmMessage()}
	confirmLabel={m.settings_cinephage_installKey_rotate()}
	confirmVariant="warning"
	loading={registering}
	onConfirm={requestRotate}
	onCancel={() => (confirmRotateOpen = false)}
/>

<ConfirmationModal
	open={confirmRevokeOpen}
	title={m.settings_cinephage_installKey_revokeConfirmTitle()}
	message={m.settings_cinephage_installKey_revokeConfirmMessage()}
	confirmLabel={m.settings_cinephage_installKey_revoke()}
	confirmVariant="error"
	loading={revoking}
	onConfirm={requestRevoke}
	onCancel={() => (confirmRevokeOpen = false)}
/>
