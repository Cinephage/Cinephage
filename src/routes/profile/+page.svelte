<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { browser } from '$app/env';
	import {
		User,
		Lock,
		Tv,
		Unlink,
		KeyRound,
		Check,
		Eye,
		EyeOff,
		Monitor,
		Smartphone,
		Tablet,
		Loader2,
		LogOut,
		Pencil,
		ShieldCheck,
		Globe,
		Palette,
		Camera,
		X,
		Trash2,
		AtSign
	} from '@lucide/svelte';
	import { authClient } from '#lib/auth/client.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { ApiError, apiGet, apiPost, apiPut, apiDelete } from '#lib/api/client.js';
	import { getRequestCounts, type RequestCountResponse } from '#lib/api/requests.js';
	import QuotaSummary from '#lib/components/requests/QuotaSummary.svelte';
	import { goto, refreshAll } from '$app/navigation';
	import { formatDisplayDate } from '#lib/utils/format.js';
	import { SettingsPage, SettingsSection } from '#lib/components/ui/settings/index.js';
	import { LanguageSelector, ThemeSelector, UserAvatar } from '#lib/components/ui/index.js';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';

	type OwnSession = {
		id: string;
		userAgent: string | null;
		ipAddress: string | null;
		createdAt: string | null;
		lastActiveAt: string | null;
		expiresAt: string | null;
		current: boolean;
	};

	let { data } = $props();

	// Request quota cards (viewers; admins are exempt and see no cards).
	let requestCounts = $state<RequestCountResponse | null>(null);
	$effect(() => {
		if (!browser || data.user?.role === 'admin') return;

		void getRequestCounts()
			.then((counts) => (requestCounts = counts))
			.catch(() => undefined);
	});

	const displayName = $derived(
		data.user?.displayUsername || data.user?.name || data.user?.username
	);
	const memberSince = $derived(
		data.user?.createdAt ? formatDisplayDate(data.user.createdAt) : null
	);

	// =====================
	// Display name
	// =====================
	let editingName = $state(false);
	let nameDraft = $state('');
	let savingName = $state(false);

	function startEditName() {
		nameDraft = data.user?.displayUsername || data.user?.name || '';
		editingName = true;
	}

	async function saveName() {
		savingName = true;
		try {
			const result = await authClient.updateUser({ displayUsername: nameDraft.trim() });
			if (result.error) {
				toasts.error(result.error.message || m.profile_nameSaveFailed());
				return;
			}
			editingName = false;
			toasts.success(m.profile_nameSaved());
			await refreshAll();
		} finally {
			savingName = false;
		}
	}

	// =====================
	// Sidebar username visibility
	// =====================
	let sidebarShowUsername = $state(true);

	$effect(() => {
		sidebarShowUsername = data.user?.sidebarShowUsername ?? true;
	});

	async function toggleSidebarShowUsername(next: boolean) {
		const previous = sidebarShowUsername;
		sidebarShowUsername = next;
		try {
			await apiPut('/api/user/preferences/sidebarShowUsername', { value: next });
			await refreshAll();
		} catch {
			sidebarShowUsername = previous;
			toasts.error(m.users_actionFailed());
		}
	}

	// =====================
	// Avatar upload
	// =====================
	let avatarInput = $state<HTMLInputElement | null>(null);
	let uploadingAvatar = $state(false);

	function triggerAvatarUpload() {
		avatarInput?.click();
	}

	async function handleAvatarChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		uploadingAvatar = true;
		try {
			const formData = new FormData();
			formData.append('avatar', file);
			const res = await fetch('/api/user/avatar', { method: 'POST', body: formData });
			const result = await res.json();
			if (!res.ok || !result.success) {
				toasts.error(result.error || m.profile_avatarUploadFailed());
				return;
			}
			await refreshAll();
		} catch {
			toasts.error(m.profile_avatarUploadFailed());
		} finally {
			uploadingAvatar = false;
			input.value = '';
		}
	}

	async function removeAvatar() {
		uploadingAvatar = true;
		try {
			const res = await fetch('/api/user/avatar', { method: 'DELETE' });
			const result = await res.json();
			if (!res.ok || !result.success) {
				toasts.error(result.error || m.profile_avatarRemoveFailed());
				return;
			}
			await refreshAll();
		} catch {
			toasts.error(m.profile_avatarRemoveFailed());
		} finally {
			uploadingAvatar = false;
		}
	}

	// =====================
	// Change password
	// =====================
	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let showPasswords = $state(false);
	let saving = $state(false);
	let saved = $state(false);

	const passwordsValid = $derived(currentPassword.length >= 8 && newPassword.length >= 8);
	const passwordsMatch = $derived(newPassword === confirmPassword);

	async function changePassword() {
		if (saving || !passwordsValid || !passwordsMatch) return;
		saving = true;
		saved = false;
		try {
			const result = await authClient.changePassword({
				currentPassword,
				newPassword,
				revokeOtherSessions: true
			});
			if (result.error) {
				toasts.error(result.error.message || m.login_invalidCredentials());
				return;
			}
			currentPassword = '';
			newPassword = '';
			confirmPassword = '';
			saved = true;
			toasts.success(m.profile_passwordUpdated());
			await refreshSessions();
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : m.common_failedToSave());
		} finally {
			saving = false;
		}
	}

	// =====================
	// Sessions
	// =====================
	let sessions = $state<OwnSession[]>([]);
	let sessionsLoading = $state(false);
	let revokingSessionId = $state<string | null>(null);
	let revokingAll = $state(false);

	async function refreshSessions() {
		if (!browser) return;
		sessionsLoading = true;
		try {
			const response = await apiGet<{ sessions: OwnSession[] }>('/api/user/sessions');
			sessions = response.sessions ?? [];
		} catch {
			// The section simply stays empty; nothing here is critical.
			sessions = [];
		} finally {
			sessionsLoading = false;
		}
	}

	$effect(() => {
		void refreshSessions();
	});

	function describeDevice(userAgent: string | null): { icon: typeof Monitor; label: string } {
		const ua = (userAgent ?? '').toLowerCase();
		if (ua.includes('mobile') || ua.includes('android')) {
			return { icon: Smartphone, label: m.users_sessionDevicePhone() };
		}
		if (ua.includes('ipad') || ua.includes('tablet')) {
			return { icon: Tablet, label: m.users_sessionDeviceTablet() };
		}
		return { icon: Monitor, label: m.users_sessionDeviceDesktop() };
	}

	function describeBrowser(userAgent: string | null): string {
		const ua = userAgent ?? '';
		if (ua.includes('Firefox/')) return 'Firefox';
		if (ua.includes('Edg/')) return 'Edge';
		if (ua.includes('Chrome/')) return 'Chrome';
		if (ua.includes('Safari/') && !ua.includes('Chrome')) return 'Safari';
		return ua.slice(0, 40) || m.users_sessionUnknownClient();
	}

	async function revokeSession(sessionId: string) {
		revokingSessionId = sessionId;
		try {
			await apiDelete('/api/user/sessions', { sessionId });
			toasts.success(m.profile_sessionRevoked());
			await refreshSessions();
		} catch {
			toasts.error(m.users_actionFailed());
		} finally {
			revokingSessionId = null;
		}
	}

	// =====================
	// Media server linking
	// =====================
	type MediaServerLink = {
		serverId: string;
		serverName: string;
		serverType: string;
		serverUserId: string;
		serverUsername: string;
		linkedAt: string | null;
	};

	type LinkableServerInfo = {
		id: string;
		name: string;
		quickConnectEnabled: boolean;
	};

	let mediaLinks = $state<MediaServerLink[]>([]);
	let linkableServers = $state<LinkableServerInfo[]>([]);
	let linkServerId = $state('');
	let pairingCode = $state('');
	let pairingActive = $state(false);
	let pairingExpired = $state(false);
	let pairingTimer: ReturnType<typeof setInterval> | null = null;

	async function refreshMediaLinks() {
		if (!browser) return;
		try {
			const response = await apiGet<{
				links: MediaServerLink[];
				servers: LinkableServerInfo[];
			}>('/api/user/media-server/link');
			mediaLinks = response.links ?? [];
			linkableServers = response.servers ?? [];
			if (!linkServerId && linkableServers.length > 0) {
				linkServerId = linkableServers[0]!.id;
			}
		} catch {
			mediaLinks = [];
			linkableServers = [];
		}
	}

	$effect(() => {
		void refreshMediaLinks();
		return () => {
			if (pairingTimer) clearInterval(pairingTimer);
		};
	});

	function stopPolling() {
		if (pairingTimer) {
			clearInterval(pairingTimer);
			pairingTimer = null;
		}
	}

	async function startPairing() {
		if (!linkServerId || pairingActive) return;
		try {
			const response = await apiPost<{ code?: string }>('/api/user/media-server/link', {
				serverId: linkServerId
			});
			pairingCode = response.code ?? '';
			pairingActive = true;
			pairingExpired = false;
			stopPolling();
			pairingTimer = setInterval(() => void pollPairing(), 2500);
		} catch (error) {
			if (
				error instanceof ApiError &&
				(error.response as { outcome?: string } | undefined)?.outcome === 'quick-connect-disabled'
			) {
				toasts.error(m.link_quickConnectDisabled());
				return;
			}
			toasts.error(error instanceof Error ? error.message : m.link_failed());
		}
	}

	async function pollPairing() {
		if (!pairingActive) return;
		try {
			const response = await apiPut<{
				outcome: string;
				link?: MediaServerLink;
			}>('/api/user/media-server/link', { serverId: linkServerId });
			if (response.outcome === 'linked') {
				stopPolling();
				pairingActive = false;
				pairingCode = '';
				toasts.success(m.link_linkedSuccess({ username: response.link?.serverUsername ?? '' }));
				await refreshMediaLinks();
			} else if (response.outcome === 'expired' || response.outcome === 'no-pairing') {
				stopPolling();
				pairingActive = false;
				pairingCode = '';
				pairingExpired = true;
			}
		} catch {
			stopPolling();
			pairingActive = false;
			pairingCode = '';
		}
	}

	function cancelPairing() {
		stopPolling();
		pairingActive = false;
		pairingCode = '';
		pairingExpired = false;
	}

	async function unlinkServer(serverId: string) {
		try {
			await apiDelete(`/api/user/media-server/link?serverId=${encodeURIComponent(serverId)}`);
			toasts.success(m.link_unlinked());
			await refreshMediaLinks();
		} catch {
			toasts.error(m.link_failed());
		}
	}

	async function revokeOtherSessions() {
		revokingAll = true;
		try {
			await apiDelete('/api/user/sessions', {});
			toasts.success(m.profile_otherSessionsRevoked());
			await refreshSessions();
		} catch {
			toasts.error(m.users_actionFailed());
		} finally {
			revokingAll = false;
		}
	}

	// =====================
	// Danger zone: delete account
	// =====================
	let deleteModalOpen = $state(false);
	let deletePassword = $state('');
	let deletingAccount = $state(false);

	function openDeleteModal() {
		deletePassword = '';
		deleteModalOpen = true;
	}

	function closeDeleteModal() {
		deleteModalOpen = false;
		deletePassword = '';
	}

	async function deleteAccount() {
		deletingAccount = true;
		try {
			const result = await authClient.deleteUser({ password: deletePassword });
			if (result.error) {
				toasts.error(result.error.message || m.users_actionFailed());
				return;
			}
			toasts.success(m.profile_deleteAccountSuccess());
			closeDeleteModal();
			await goto('/login');
		} finally {
			deletingAccount = false;
		}
	}
</script>

<svelte:head>
	<title>{m.profile_pageTitle()}</title>
</svelte:head>

<SettingsPage title={m.profile_title()} subtitle={m.profile_subtitle()}>
	<!-- Request quota -->
	{#if requestCounts}
		<SettingsSection
			title={m.requests_profileQuotaTitle()}
			description={m.requests_profileQuotaDescription()}
		>
			<div class="grid gap-2 sm:grid-cols-2">
				<QuotaSummary quota={requestCounts.quota.movie} type="movie" />
				<QuotaSummary quota={requestCounts.quota.tv} type="tv" />
			</div>
		</SettingsSection>
	{/if}

	<!-- Identity -->
	<SettingsSection title={m.profile_accountSecurity()}>
		<div class="flex flex-col gap-4 sm:flex-row sm:items-center">
			<div class="group relative shrink-0">
				<UserAvatar
					name={displayName || '?'}
					src={data.user?.image ??
						(data.user?.mediaServerId
							? `/api/user/media-server/avatar/${data.user.mediaServerId}`
							: null)}
					size="lg"
				/>
				<input
					bind:this={avatarInput}
					type="file"
					accept="image/png,image/jpeg,image/webp"
					class="hidden"
					onchange={handleAvatarChange}
				/>
				<button
					class="btn absolute -right-1 -bottom-1 btn-circle bg-base-100 btn-ghost btn-xs"
					aria-label={m.action_upload()}
					disabled={uploadingAvatar}
					onclick={triggerAvatarUpload}
				>
					{#if uploadingAvatar}
						<Loader2 class="h-3.5 w-3.5 animate-spin" />
					{:else}
						<Camera class="h-3.5 w-3.5" />
					{/if}
				</button>
				{#if data.user?.image}
					<button
						class="btn absolute -top-1 -right-1 btn-circle bg-base-100 btn-ghost text-error btn-xs"
						aria-label={m.action_delete()}
						disabled={uploadingAvatar}
						onclick={removeAvatar}
					>
						<X class="h-3 w-3" />
					</button>
				{/if}
			</div>
			<div class="min-w-0 flex-1">
				{#if editingName}
					<div class="flex max-w-md items-center gap-2">
						<input
							type="text"
							class="input-bordered input w-full input-sm"
							bind:value={nameDraft}
							maxlength={64}
						/>
						<button
							class="btn btn-primary btn-sm"
							disabled={savingName || nameDraft.trim().length === 0}
							onclick={saveName}
						>
							{#if savingName}
								<Loader2 class="h-4 w-4 animate-spin" />
							{:else}
								<Check class="h-4 w-4" />
							{/if}
							{m.action_save()}
						</button>

						<button class="btn btn-ghost btn-sm" onclick={() => (editingName = false)}
							>{m.action_cancel()}</button
						>
					</div>
				{:else}
					<div class="flex items-center gap-2">
						<h3 class="truncate text-lg font-medium">{displayName}</h3>
						<button
							class="btn btn-ghost btn-xs"
							aria-label={m.profile_editName()}
							onclick={startEditName}
						>
							<Pencil class="h-3.5 w-3.5" />
						</button>
					</div>
				{/if}
				<div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-base-content/60">
					{#if data.user?.username}
						<span>@{data.user.username}</span>
					{/if}
					{#if data.user?.role === 'admin'}
						<span class="badge gap-1 badge-xs badge-primary">
							<ShieldCheck class="h-3 w-3" />
							{m.users_roleAdmin()}
						</span>
					{:else}
						<span class="badge gap-1 badge-ghost badge-xs">
							<User class="h-3 w-3" />
							{m.users_roleUser()}
						</span>
					{/if}
				</div>
			</div>
			<dl class="grid w-full grid-cols-1 gap-x-6 gap-y-2 text-sm sm:w-auto sm:min-w-72">
				<div class="flex items-center gap-2">
					<dt class="w-28 shrink-0 text-base-content/50">{m.users_columnEmail()}</dt>
					<dd class="min-w-0 truncate">{data.user?.email}</dd>
				</div>
				{#if memberSince}
					<div class="flex items-center gap-2">
						<dt class="w-28 shrink-0 text-base-content/50">{m.profile_memberSince()}</dt>
						<dd>{memberSince}</dd>
					</div>
				{/if}
			</dl>
		</div>
	</SettingsSection>

	<!-- Preferences -->
	<SettingsSection
		title={m.profile_preferencesTitle()}
		description={m.profile_preferencesDescription()}
	>
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-2 text-sm">
				<Globe class="h-4 w-4 text-base-content/50" />
				{m.profile_interfaceLanguage()}
			</div>
			<LanguageSelector showLabel={false} />
		</div>
		<div class="mt-3 flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-2 text-sm">
				<Palette class="h-4 w-4 text-base-content/50" />
				{m.ui_themeLabel()}
			</div>
			<ThemeSelector showLabel={false} />
		</div>
		<div class="mt-3 flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-2 text-sm">
				<AtSign class="h-4 w-4 text-base-content/50" />
				{m.profile_sidebarShowUsername()}
			</div>
			<input
				type="checkbox"
				class="toggle toggle-sm"
				checked={sidebarShowUsername}
				onchange={(e) => toggleSidebarShowUsername(e.currentTarget.checked)}
			/>
		</div>
	</SettingsSection>

	<!-- Media server -->
	<SettingsSection title={m.link_sectionTitle()} description={m.link_sectionDescription()}>
		{#if mediaLinks.length > 0}
			<ul class="divide-y divide-base-content/10">
				{#each mediaLinks as mediaLink (mediaLink.serverId)}
					<li class="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
						<Tv class="h-5 w-5 shrink-0 text-base-content/40" />
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<span class="text-sm font-medium">{mediaLink.serverUsername}</span>
								<span class="badge badge-ghost badge-xs">{mediaLink.serverName}</span>
							</div>
							{#if mediaLink.linkedAt}
								<div class="mt-0.5 text-xs text-base-content/50">
									{m.link_linkedSince({ date: formatDisplayDate(mediaLink.linkedAt) })}
								</div>
							{/if}
						</div>
						<button
							class="btn btn-ghost text-error btn-xs"
							onclick={() => unlinkServer(mediaLink.serverId)}
						>
							<Unlink class="h-3.5 w-3.5" />
							{m.link_unlinkAction()}
						</button>
					</li>
				{/each}
			</ul>
		{:else if linkableServers.length === 0}
			<p class="text-sm text-base-content/60">{m.link_noServers()}</p>
		{:else if pairingActive}
			<div class="flex flex-col items-center gap-3 py-4">
				<div class="font-mono text-4xl font-bold tracking-[0.3em]">{pairingCode}</div>
				<p class="max-w-md text-center text-sm text-base-content/70">
					{m.link_pairingInstructions()}
				</p>
				<div class="flex items-center gap-2 text-xs text-base-content/50">
					<Loader2 class="h-3.5 w-3.5 animate-spin" />
					{m.link_pairingWaiting()}
				</div>
				<button class="btn btn-ghost btn-sm" onclick={cancelPairing}>
					{m.action_cancel()}
				</button>
			</div>
		{:else}
			<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				{#if pairingExpired}
					<p class="text-sm text-warning">{m.link_pairingExpired()}</p>
				{:else}
					<p class="text-sm text-base-content/60">{m.link_notLinked()}</p>
				{/if}
				<div class="flex items-center gap-2">
					{#if linkableServers.length > 1}
						<select class="select-bordered select select-sm" bind:value={linkServerId}>
							{#each linkableServers as server (server.id)}
								<option value={server.id}>{server.name}</option>
							{/each}
						</select>
					{/if}
					<button class="btn btn-outline btn-sm" onclick={startPairing}>
						<Tv class="h-4 w-4" />
						{m.link_connectAction()}
					</button>
				</div>
			</div>
		{/if}
	</SettingsSection>

	<!-- Password -->
	<SettingsSection
		title={m.profile_changePassword()}
		description={m.profile_changePasswordDescription()}
	>
		<form
			class="max-w-md space-y-4"
			onsubmit={(e) => {
				e.preventDefault();
				changePassword();
			}}
		>
			<div class="form-control">
				<label class="label" for="current-password">
					<span class="label-text">{m.profile_currentPassword()}</span>
				</label>
				<div class="relative">
					<input
						id="current-password"
						type={showPasswords ? 'text' : 'password'}
						class="input-bordered input w-full pr-12"
						bind:value={currentPassword}
						required
						autocomplete="current-password"
					/>
					<button
						type="button"
						class="btn absolute top-1/2 right-2 -translate-y-1/2 btn-ghost btn-sm"
						aria-label={showPasswords ? 'Hide password' : 'Show password'}
						aria-pressed={showPasswords}
						onclick={() => (showPasswords = !showPasswords)}
					>
						{#if showPasswords}
							<EyeOff class="h-4 w-4" />
						{:else}
							<Eye class="h-4 w-4" />
						{/if}
					</button>
				</div>
			</div>

			<div class="form-control">
				<label class="label" for="new-password">
					<span class="label-text">{m.profile_newPassword()}</span>
				</label>
				<input
					id="new-password"
					type={showPasswords ? 'text' : 'password'}
					class="input-bordered input w-full"
					bind:value={newPassword}
					required
					minlength="8"
					autocomplete="new-password"
				/>
			</div>

			<div class="form-control">
				<label class="label" for="confirm-password">
					<span class="label-text">{m.profile_confirmPassword()}</span>
				</label>
				<input
					id="confirm-password"
					type={showPasswords ? 'text' : 'password'}
					class="input-bordered input w-full"
					bind:value={confirmPassword}
					required
					minlength="8"
					autocomplete="new-password"
				/>
				{#if confirmPassword && !passwordsMatch}
					<p class="mt-1 text-xs text-error">{m.profile_passwordMismatch()}</p>
				{/if}
			</div>

			<button
				type="submit"
				class="btn btn-primary"
				disabled={saving || !passwordsValid || !passwordsMatch}
			>
				{#if saving}
					<span class="loading loading-spinner"></span>
					{m.common_saving()}
				{:else if saved}
					<Check class="h-4 w-4" />
					{m.profile_passwordUpdated()}
				{:else}
					<KeyRound class="h-4 w-4" />
					{m.profile_changePassword()}
				{/if}
			</button>
		</form>
	</SettingsSection>

	<!-- Sessions -->
	<SettingsSection title={m.profile_sessionsTitle()} description={m.profile_sessionsDescription()}>
		{#snippet actions()}
			{#if sessions.filter((s) => !s.current).length > 0}
				<button
					class="btn gap-1.5 btn-ghost btn-sm"
					disabled={revokingAll}
					onclick={revokeOtherSessions}
				>
					{#if revokingAll}
						<Loader2 class="h-4 w-4 animate-spin" />
					{:else}
						<LogOut class="h-4 w-4" />
					{/if}
					{m.users_revokeSessionsAction()}
				</button>
			{/if}
		{/snippet}

		{#if sessionsLoading}
			<div class="flex items-center gap-2 text-sm text-base-content/60">
				<Loader2 class="h-4 w-4 animate-spin" />
				{m.common_loading()}
			</div>
		{:else if sessions.length === 0}
			<p class="text-sm text-base-content/60">{m.users_noSessions()}</p>
		{:else}
			<ul class="divide-y divide-base-content/10">
				{#each sessions as ownSession (ownSession.id)}
					{@const device = describeDevice(ownSession.userAgent)}
					<li class="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
						<device.icon class="h-5 w-5 shrink-0 text-base-content/40" />
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<span class="text-sm font-medium">{device.label}</span>
								<span class="text-sm text-base-content/50">
									{describeBrowser(ownSession.userAgent)}
								</span>
								{#if ownSession.current}
									<span class="badge badge-xs badge-primary">{m.users_sessionCurrent()}</span>
								{/if}
							</div>
							<div class="mt-0.5 text-xs text-base-content/50">
								{#if ownSession.ipAddress}
									{ownSession.ipAddress} ·
								{/if}
								{ownSession.createdAt ? formatDisplayDate(ownSession.createdAt) : ''}
								{#if ownSession.lastActiveAt}
									· {m.profile_lastActive()} {formatDisplayDate(ownSession.lastActiveAt)}
								{/if}
							</div>
						</div>
						{#if !ownSession.current}
							<button
								class="btn btn-ghost text-error btn-xs"
								disabled={revokingSessionId === ownSession.id}
								onclick={() => revokeSession(ownSession.id)}
							>
								{#if revokingSessionId === ownSession.id}
									<Loader2 class="h-3.5 w-3.5 animate-spin" />
								{:else}
									<Lock class="h-3.5 w-3.5" />
									{m.users_sessionRevoke()}
								{/if}
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</SettingsSection>

	<!-- Danger zone: hidden when user is the sole admin -->
	{#if !data.isOnlyAdmin}
		<SettingsSection
			title={m.profile_dangerZoneTitle()}
			description={m.profile_dangerZoneDescription()}
			class="border border-error/20"
		>
			<button class="btn gap-1.5 btn-outline btn-error btn-sm" onclick={openDeleteModal}>
				<Trash2 class="h-4 w-4" />
				{m.profile_deleteAccount()}
			</button>
		</SettingsSection>
	{/if}
</SettingsPage>

<ConfirmationModal
	open={deleteModalOpen}
	title={m.profile_deleteAccountConfirmTitle()}
	message={m.profile_deleteAccountConfirmMessage()}
	confirmLabel={m.profile_deleteAccount()}
	confirmVariant="error"
	loading={deletingAccount}
	onConfirm={deleteAccount}
	onCancel={closeDeleteModal}
>
	<div class="form-control mt-2">
		<label class="label" for="delete-account-password">
			<span class="label-text">{m.profile_currentPassword()}</span>
		</label>
		<input
			id="delete-account-password"
			type="password"
			class="input-bordered input w-full"
			bind:value={deletePassword}
			autocomplete="current-password"
		/>
	</div>
</ConfirmationModal>
