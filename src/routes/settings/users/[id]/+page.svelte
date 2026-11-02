<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { goto, refreshAll } from '$app/navigation';
	import { resolvePath } from '#lib/utils/routing.js';
	import { page } from '$app/state';
	import {
		ArrowLeft,
		ShieldCheck,
		User,
		Ban,
		KeyRound,
		Trash2,
		Monitor,
		Smartphone,
		Tablet,
		Loader2,
		LogOut,
		RotateCcw,
		Tv,
		Unlink
	} from '@lucide/svelte';
	import { authClient } from '#lib/auth/client.js';
	import { ApiError, apiGet, apiPost, apiDelete } from '#lib/api/client.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { formatDisplayDate } from '#lib/utils/format.js';
	import { SettingsPage, SettingsSection } from '#lib/components/ui/settings/index.js';
	import { UserAvatar } from '#lib/components/ui/index.js';
	import { ToggleSetting } from '#lib/components/ui/modal/index.js';
	import {
		getUserRequestSettings,
		saveUserRequestSettings,
		type UserRequestSettings
	} from '#lib/api/requests.js';
	import {
		ConfirmationModal,
		ModalWrapper,
		ModalHeader,
		ModalFooter
	} from '#lib/components/ui/modal/index.js';

	let { data } = $props();

	// Per-user request settings (admin-managed overrides).
	let requestSettings = $state<UserRequestSettings | null>(null);
	let requestSettingsLoaded = $state(false);
	let savingRequestSettings = $state(false);

	const currentUserId = $derived(page.data.user?.id ?? '');
	const isSelf = $derived(data.profile.id === currentUserId);
	const isLastAdmin = $derived(data.profile.role === 'admin' && data.adminCount <= 1);
	const displayName = $derived(
		data.profile.displayUsername || data.profile.name || data.profile.username || data.profile.email
	);

	async function loadRequestSettings() {
		try {
			const response = await getUserRequestSettings(data.profile.id);
			requestSettings = response.settings;
		} catch {
			// Section renders only once loaded.
		} finally {
			requestSettingsLoaded = true;
		}
	}

	$effect(() => {
		void data.profile.id;
		requestSettingsLoaded = false;
		void loadRequestSettings();
	});

	async function updateRequestSettings(update: Partial<UserRequestSettings>) {
		if (!requestSettings) return;
		savingRequestSettings = true;
		try {
			const response = await saveUserRequestSettings(data.profile.id, update);
			requestSettings = response.settings;
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : m.requests_errorGeneric());
		} finally {
			savingRequestSettings = false;
		}
	}

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

	async function runAction(
		action: () => Promise<{ error?: { message?: string } | null }>
	): Promise<boolean> {
		const result = await action();
		if (result.error) {
			toasts.error(result.error.message || m.users_actionFailed());
			return false;
		}
		await refreshAll();
		return true;
	}

	// =====================
	// Role and ban
	// =====================
	async function handleSetRole(role: 'user' | 'admin') {
		if (isSelf && role === 'user') {
			toasts.error(m.users_cannotDemoteSelf());
			return;
		}
		let ok = await runAction(() => authClient.admin.setRole({ userId: data.profile.id, role }));
		if (ok && role === 'user') {
			// Sign the demoted admin out so no elevated session survives.
			ok = await runAction(() => authClient.admin.revokeUserSessions({ userId: data.profile.id }));
		}
		if (ok) {
			toasts.success(
				role === 'admin'
					? m.users_promoted({ username: data.profile.username ?? '' })
					: m.users_demoted({ username: data.profile.username ?? '' })
			);
		}
	}

	let banModalOpen = $state(false);
	let banReason = $state('');
	// Duration presets in seconds; 0 = permanent.
	let banDuration = $state(0);
	const BAN_DURATIONS: Array<{ value: number; labelKey: () => string }> = [
		{ value: 0, labelKey: () => m.users_banPermanent() },
		{ value: 24 * 60 * 60, labelKey: () => m.users_ban1Day() },
		{ value: 3 * 24 * 60 * 60, labelKey: () => m.users_ban3Days() },
		{ value: 7 * 24 * 60 * 60, labelKey: () => m.users_ban1Week() },
		{ value: 30 * 24 * 60 * 60, labelKey: () => m.users_ban30Days() }
	];

	function isBanExpired(expiresAt: string | null): boolean {
		if (!expiresAt) return false;
		return new Date(expiresAt).getTime() < Date.now();
	}
	let banningUser = $state(false);

	async function handleBanToggle() {
		if (data.profile.banned) {
			const ok = await runAction(() => authClient.admin.unbanUser({ userId: data.profile.id }));
			if (ok) toasts.success(m.users_unbanned({ username: data.profile.username ?? '' }));
			return;
		}
		banReason = '';
		banDuration = 0;
		banModalOpen = true;
	}

	async function handleBan() {
		banningUser = true;
		try {
			const ok = await runAction(() =>
				authClient.admin.banUser({
					userId: data.profile.id,
					banReason: banReason.trim() || m.users_defaultBanReason(),
					...(banDuration > 0 ? { banExpiresIn: banDuration } : {})
				})
			);
			if (ok) {
				toasts.success(m.users_banned({ username: data.profile.username ?? '' }));
				banModalOpen = false;
			}
		} finally {
			banningUser = false;
		}
	}

	// =====================
	// Password reset
	// =====================
	let passwordModalOpen = $state(false);
	let newPassword = $state('');
	let resettingPassword = $state(false);

	function generatePassword(): void {
		const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
		const bytes = new Uint32Array(20);
		crypto.getRandomValues(bytes);
		newPassword = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
	}

	async function handleSetPassword() {
		if (newPassword.length < 8) {
			toasts.error(m.users_passwordTooShort());
			return;
		}
		resettingPassword = true;
		try {
			const ok = await runAction(() =>
				authClient.admin.setUserPassword({ userId: data.profile.id, newPassword })
			);
			if (!ok) return;
			// A password reset must invalidate existing sessions; the plugin
			// endpoint does not revoke them on its own.
			const revoked = await runAction(() =>
				authClient.admin.revokeUserSessions({ userId: data.profile.id })
			);
			if (revoked) {
				toasts.success(m.users_passwordSet({ username: data.profile.username ?? '' }));
				passwordModalOpen = false;
			} else {
				toasts.error(m.users_passwordSetNoRevoke({ username: data.profile.username ?? '' }));
			}
		} finally {
			resettingPassword = false;
		}
	}

	// =====================
	// Sessions
	// =====================
	let revokingSessionId = $state<string | null>(null);

	async function handleRevokeSession(target: { id: string }) {
		revokingSessionId = target.id;
		try {
			// Revocation resolves the session token server-side by id — the
			// raw token is a live bearer credential and never ships to the
			// browser.
			const ok = await runAction(() =>
				fetch(`/api/settings/users/${data.profile.id}/sessions/${target.id}/revoke`, {
					method: 'POST'
				}).then((response): { error?: { message?: string } | null } =>
					response.ok ? {} : { error: { message: `HTTP ${response.status}` } }
				)
			);
			if (ok) toasts.success(m.users_sessionRevoked());
		} finally {
			revokingSessionId = null;
		}
	}

	let revokingAllSessions = $state(false);

	async function handleRevokeAllSessions() {
		revokingAllSessions = true;
		try {
			const ok = await runAction(() =>
				authClient.admin.revokeUserSessions({ userId: data.profile.id })
			);
			if (ok) toasts.success(m.users_sessionsRevoked({ username: data.profile.username ?? '' }));
		} finally {
			revokingAllSessions = false;
		}
	}

	// =====================
	// Media server link (admin-mediated)
	// =====================
	type MediaServerLink = {
		serverId: string;
		serverName: string;
		serverType: string;
		serverUserId: string;
		serverUsername: string;
		linkedAt: string | null;
	};

	type LinkableServerInfo = { id: string; name: string; quickConnectEnabled: boolean };
	type ServerUserOption = { id: string; name: string; isAdministrator: boolean };

	// Local editable copies seeded once from the load data; they diverge as
	// the admin links/unlinks servers and are refreshed on save.
	// svelte-ignore state_referenced_locally
	let mediaLinks = $state<MediaServerLink[]>(data.mediaLinks ?? []);
	// svelte-ignore state_referenced_locally
	let linkableServers = $state<LinkableServerInfo[]>(data.linkableServers ?? []);
	let linkServerId = $state('');
	let serverUsers = $state<ServerUserOption[] | null>(null);
	let loadingUsers = $state(false);
	let linkingUser = $state(false);
	let unlinkingServerId = $state<string | null>(null);
	let linkServerUserId = $state('');

	async function loadServerUsers() {
		if (!linkServerId) {
			serverUsers = null;
			return;
		}
		loadingUsers = true;
		try {
			const response = await apiGet<{ users: ServerUserOption[] | null }>(
				`/api/settings/users/${data.profile.id}/media-server-link?serverId=${encodeURIComponent(linkServerId)}`
			);
			serverUsers = response.users ?? [];
			linkServerUserId = '';
		} catch {
			serverUsers = null;
			toasts.error(m.link_failed());
		} finally {
			loadingUsers = false;
		}
	}

	async function handleAdminLink() {
		if (!linkServerId || !linkServerUserId || linkingUser) return;
		linkingUser = true;
		try {
			const result = await apiPost<{ link?: MediaServerLink }>(
				`/api/settings/users/${data.profile.id}/media-server-link`,
				{ serverId: linkServerId, serverUserId: linkServerUserId }
			);
			toasts.success(m.link_linkedSuccess({ username: result.link?.serverUsername ?? '' }));
			mediaLinks = [...mediaLinks, result.link!];
			serverUsers = null;
			linkServerUserId = '';
		} catch (error) {
			if (error instanceof ApiError && error.response?.error) {
				toasts.error(error.response.error);
			} else {
				toasts.error(m.link_failed());
			}
		} finally {
			linkingUser = false;
		}
	}

	async function handleAdminUnlink(serverId: string) {
		unlinkingServerId = serverId;
		try {
			await apiDelete(
				`/api/settings/users/${data.profile.id}/media-server-link?serverId=${encodeURIComponent(serverId)}`
			);
			mediaLinks = mediaLinks.filter((link) => link.serverId !== serverId);
			toasts.success(m.link_unlinked());
		} catch {
			toasts.error(m.link_failed());
		} finally {
			unlinkingServerId = null;
		}
	}

	// =====================
	// Danger zone: delete user account
	// =====================

	let deleteModalOpen = $state(false);
	let deletingUser = $state(false);

	function openDeleteModal() {
		deleteModalOpen = true;
	}

	function closeDeleteModal() {
		deleteModalOpen = false;
	}

	async function handleDelete() {
		deletingUser = true;
		try {
			const result = await authClient.admin.removeUser({ userId: data.profile.id });
			if (result.error) {
				toasts.error(result.error.message || m.users_actionFailed());
				return;
			}
			toasts.success(m.users_deleted({ username: data.profile.username ?? '' }));
			closeDeleteModal();
			await goto(resolvePath('/settings/users'), { invalidateAll: true });
		} finally {
			deletingUser = false;
		}
	}
</script>

<svelte:head>
	<title>{displayName} - {m.nav_users()} - Cinephage</title>
</svelte:head>

<SettingsPage title={displayName} subtitle={m.users_detailSubtitle()}>
	{#snippet actions()}
		<a href={resolvePath('/settings/users')} class="btn gap-1.5 btn-ghost btn-sm">
			<ArrowLeft class="h-4 w-4" />
			{m.users_backToList()}
		</a>
	{/snippet}

	<!-- Account -->
	<SettingsSection title={m.users_accountsTitle()}>
		<div class="flex flex-col gap-4">
			<div class="flex flex-col gap-4 sm:flex-row sm:items-center">
				<UserAvatar
					name={displayName}
					src={data.profile.image ??
						(data.mediaLinks?.[0]
							? `/api/settings/users/${data.profile.id}/media-server/avatar/${data.mediaLinks[0].serverId}`
							: null)}
					size="lg"
				/>
				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-center gap-2">
						{#if data.profile.role === 'admin'}
							<span class="badge gap-1 badge-sm badge-primary">
								<ShieldCheck class="h-3 w-3" />
								{m.users_roleAdmin()}
							</span>
						{:else}
							<span class="badge gap-1 badge-ghost badge-sm">
								<User class="h-3 w-3" />
								{m.users_roleUser()}
							</span>
						{/if}
						{#if data.profile.banned}
							<span class="badge badge-sm badge-error">
								{#if data.profile.banExpires && !isBanExpired(data.profile.banExpires)}
									{m.users_bannedUntil({ date: formatDisplayDate(data.profile.banExpires) })}
								{:else if data.profile.banExpires && isBanExpired(data.profile.banExpires)}
									{m.users_banExpired()}
								{:else}
									{m.users_bannedStatus()}
								{/if}
							</span>
						{:else}
							<span class="badge badge-outline badge-sm badge-success">
								{m.users_activeStatus()}
							</span>
						{/if}
						{#if isSelf}
							<span class="badge badge-ghost badge-xs">{m.users_youBadge()}</span>
						{/if}
					</div>
					<dl class="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
						<div class="flex items-center gap-2">
							<dt class="w-28 shrink-0 text-base-content/50">{m.users_columnEmail()}</dt>
							<dd class="min-w-0 truncate">{data.profile.email}</dd>
						</div>
						<div class="flex items-center gap-2">
							<dt class="w-28 shrink-0 text-base-content/50">{m.users_columnCreated()}</dt>
							<dd>{data.profile.createdAt ? formatDisplayDate(data.profile.createdAt) : '—'}</dd>
						</div>
						{#if data.profile.username}
							<div class="flex items-center gap-2">
								<dt class="w-28 shrink-0 text-base-content/50">{m.users_formUsername()}</dt>
								<dd class="min-w-0 truncate">@{data.profile.username}</dd>
							</div>
						{/if}
						{#if data.sessions.length === 0 && data.profile.lastActiveAt}
							<div class="flex items-center gap-2">
								<dt class="w-28 shrink-0 text-base-content/50">{m.profile_lastActive()}</dt>
								<dd>{formatDisplayDate(data.profile.lastActiveAt)}</dd>
							</div>
						{/if}

						{#if data.profile.banned && data.profile.banReason}
							<div class="flex items-center gap-2">
								<dt class="w-28 shrink-0 text-base-content/50">{m.users_banReasonLabel()}</dt>
								<dd class="min-w-0 truncate">{data.profile.banReason}</dd>
							</div>
						{/if}
					</dl>
				</div>
			</div>

			<div class="divider my-0"></div>

			<div class="flex flex-wrap gap-2">
				{#if data.profile.role === 'admin'}
					<button
						class="btn btn-outline btn-sm"
						disabled={isSelf || isLastAdmin}
						title={isLastAdmin ? m.users_lastAdminHint() : ''}
						onclick={() => handleSetRole('user')}
					>
						<User class="h-4 w-4" />
						{m.users_demoteAction()}
					</button>
				{:else}
					<button class="btn btn-outline btn-sm" onclick={() => handleSetRole('admin')}>
						<ShieldCheck class="h-4 w-4" />
						{m.users_promoteAction()}
					</button>
				{/if}
				{#if data.profile.banned}
					<button class="btn btn-outline btn-sm" onclick={handleBanToggle}>
						<Ban class="h-4 w-4" />
						{m.users_unbanAction()}
					</button>
				{:else}
					<button
						class="btn btn-outline btn-sm"
						disabled={isSelf}
						title={isSelf ? m.users_cannotBanSelf() : ''}
						onclick={handleBanToggle}
					>
						<Ban class="h-4 w-4" />
						{m.users_banAction()}
					</button>
				{/if}
				<button
					class="btn btn-outline btn-sm"
					onclick={() => {
						newPassword = '';
						generatePassword();
						passwordModalOpen = true;
					}}
				>
					<KeyRound class="h-4 w-4" />
					{m.users_setPasswordAction()}
				</button>
			</div>
		</div>
	</SettingsSection>

	<!-- Sessions -->
	<SettingsSection
		title={m.users_sessionsTitle()}
		description={m.users_sessionsDescription({ count: data.sessions.length })}
	>
		{#snippet actions()}
			{#if data.sessions.length > 0}
				<button
					class="btn gap-1.5 btn-ghost btn-sm"
					disabled={revokingAllSessions}
					onclick={handleRevokeAllSessions}
				>
					{#if revokingAllSessions}
						<Loader2 class="h-4 w-4 animate-spin" />
					{:else}
						<LogOut class="h-4 w-4" />
					{/if}
					{m.users_revokeSessionsAction()}
				</button>
			{/if}
		{/snippet}

		{#if data.sessions.length === 0}
			<p class="text-sm text-base-content/60">{m.users_noSessions()}</p>
		{:else}
			<ul class="divide-y divide-base-content/10">
				{#each data.sessions as userSession (userSession.id)}
					{@const device = describeDevice(userSession.userAgent ?? null)}
					<li class="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
						<device.icon class="h-5 w-5 shrink-0 text-base-content/40" />
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<span class="text-sm font-medium">{device.label}</span>
								<span class="text-sm text-base-content/50">
									{describeBrowser(userSession.userAgent ?? null)}
								</span>
								{#if userSession.current}
									<span class="badge badge-xs badge-primary">{m.users_sessionCurrent()}</span>
								{/if}
							</div>
							<div class="mt-0.5 text-xs text-base-content/50">
								{#if userSession.ipAddress}
									{userSession.ipAddress} ·
								{/if}
								{userSession.createdAt ? formatDisplayDate(userSession.createdAt) : ''}
							</div>
						</div>
						{#if !userSession.current}
							<button
								class="btn btn-ghost text-error btn-xs"
								disabled={revokingSessionId === userSession.id}
								onclick={() => handleRevokeSession(userSession)}
							>
								{#if revokingSessionId === userSession.id}
									<Loader2 class="h-3.5 w-3.5 animate-spin" />
								{:else}
									{m.users_sessionRevoke()}
								{/if}
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</SettingsSection>

	<!-- Media server link -->
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
						</div>
						<button
							class="btn btn-ghost text-error btn-xs"
							disabled={unlinkingServerId === mediaLink.serverId}
							onclick={() => handleAdminUnlink(mediaLink.serverId)}
						>
							{#if unlinkingServerId === mediaLink.serverId}
								<Loader2 class="h-3.5 w-3.5 animate-spin" />
							{:else}
								<Unlink class="h-3.5 w-3.5" />
								{m.link_unlinkAction()}
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}

		{#if linkableServers.length === 0}
			<p class="text-sm text-base-content/60">{m.link_noServers()}</p>
		{:else if mediaLinks.length === 0}
			<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
				<select
					class="select-bordered select select-sm sm:w-56"
					bind:value={linkServerId}
					onchange={loadServerUsers}
				>
					<option value="">{m.link_pickServer()}</option>
					{#each linkableServers as server (server.id)}
						<option value={server.id}>{server.name}</option>
					{/each}
				</select>
				{#if loadingUsers}
					<span class="loading loading-sm loading-spinner"></span>
				{:else if serverUsers && serverUsers.length > 0}
					<select class="select-bordered select select-sm sm:w-56" bind:value={linkServerUserId}>
						<option value="">{m.link_pickUser()}</option>
						{#each serverUsers as serverUser (serverUser.id)}
							<option value={serverUser.id}>{serverUser.name}</option>
						{/each}
					</select>
					<button
						class="btn btn-outline btn-sm"
						disabled={!linkServerUserId || linkingUser}
						onclick={handleAdminLink}
					>
						{#if linkingUser}
							<Loader2 class="h-4 w-4 animate-spin" />
						{/if}
						{m.link_connectAction()}
					</button>
				{:else if serverUsers && serverUsers.length === 0}
					<span class="text-sm text-base-content/60">{m.link_noServerUsers()}</span>
				{/if}
			</div>
			<p class="mt-2 text-xs text-base-content/50">{m.link_adminHint()}</p>
		{/if}
	</SettingsSection>

	<!-- Request settings (admin overrides) -->
	{#if requestSettingsLoaded && requestSettings}
		<SettingsSection
			title={m.requestsSettings_title()}
			description={m.requestsSettings_userDisableHint()}
		>
			<div class="space-y-4">
				<ToggleSetting
					checked={requestSettings.requestsDisabled}
					label={m.requestsSettings_userDisable()}
					description={m.requestsSettings_userDisableHint()}
					disabled={savingRequestSettings}
					onchange={() => {
						void updateRequestSettings({ requestsDisabled: !requestSettings!.requestsDisabled });
					}}
				/>
				<div>
					<p class="mb-2 text-sm font-medium">{m.requestsSettings_userAutoApprove()}</p>
					<select
						class="select-bordered select w-56 select-sm"
						disabled={savingRequestSettings}
						value={requestSettings.autoApprove === null
							? 'inherit'
							: requestSettings.autoApprove
								? 'on'
								: 'off'}
						onchange={(e) => {
							const v = e.currentTarget.value;
							void updateRequestSettings({
								autoApprove: v === 'inherit' ? null : v === 'on'
							});
						}}
					>
						<option value="inherit">{m.requestsSettings_userAutoApproveInherit()}</option>
						<option value="on">{m.requests_filterApproved()}</option>
						<option value="off">{m.requests_filterDeclined()}</option>
					</select>
				</div>

				<div>
					<div class="mb-2 flex items-center justify-between gap-2">
						<p class="text-sm font-medium">{m.requestsSettings_userQuotaOverride()}</p>
						<button
							type="button"
							class="btn gap-1 btn-ghost text-base-content/50 btn-xs"
							disabled={savingRequestSettings}
							onclick={() => {
								void updateRequestSettings({
									movieQuotaLimit: null,
									movieQuotaDays: null,
									tvQuotaLimit: null,
									tvQuotaDays: null
								});
							}}
						>
							<RotateCcw class="h-3 w-3" />
							{m.requestsSettings_userQuotaOverrideReset()}
						</button>
					</div>
					<div class="grid gap-3 sm:grid-cols-2">
						<div>
							<p class="mb-1 text-xs text-base-content/60">{m.requestsSettings_movieQuota()}</p>
							<div class="flex items-center gap-1.5">
								<input
									type="number"
									min="0"
									class="input-bordered input w-20 input-sm"
									placeholder="∞"
									value={requestSettings.movieQuotaLimit ?? ''}
									onchange={(e) =>
										updateRequestSettings({
											movieQuotaLimit:
												e.currentTarget.value === '' ? null : Number(e.currentTarget.value)
										})}
								/>
								<span class="text-xs text-base-content/45">{m.requestsSettings_quotaPer()}</span>
								<input
									type="number"
									min="1"
									class="input-bordered input w-16 input-sm"
									placeholder={m.requestsSettings_quotaDays()}
									value={requestSettings.movieQuotaDays ?? ''}
									onchange={(e) =>
										updateRequestSettings({
											movieQuotaDays:
												e.currentTarget.value === '' ? null : Number(e.currentTarget.value)
										})}
								/>
							</div>
						</div>
						<div>
							<p class="mb-1 text-xs text-base-content/60">{m.requestsSettings_tvQuota()}</p>
							<div class="flex items-center gap-1.5">
								<input
									type="number"
									min="0"
									class="input-bordered input w-20 input-sm"
									placeholder="∞"
									value={requestSettings.tvQuotaLimit ?? ''}
									onchange={(e) =>
										updateRequestSettings({
											tvQuotaLimit:
												e.currentTarget.value === '' ? null : Number(e.currentTarget.value)
										})}
								/>
								<span class="text-xs text-base-content/45">{m.requestsSettings_quotaPer()}</span>
								<input
									type="number"
									min="1"
									class="input-bordered input w-16 input-sm"
									placeholder={m.requestsSettings_quotaDays()}
									value={requestSettings.tvQuotaDays ?? ''}
									onchange={(e) =>
										updateRequestSettings({
											tvQuotaDays:
												e.currentTarget.value === '' ? null : Number(e.currentTarget.value)
										})}
								/>
							</div>
						</div>
					</div>
				</div>
			</div></SettingsSection
		>
	{/if}

	<!-- Danger zone: hidden when the target is the sole admin -->
	{#if !isLastAdmin}
		<SettingsSection
			title={m.users_dangerZoneTitle()}
			description={m.users_dangerZoneDescription()}
			class="border border-error/20"
		>
			<button class="btn gap-1.5 btn-outline btn-error btn-sm" onclick={openDeleteModal}>
				<Trash2 class="h-4 w-4" />
				{m.users_deleteAction()}
			</button>
		</SettingsSection>
	{/if}
</SettingsPage>

<!-- Ban modal -->
<ModalWrapper open={banModalOpen} onClose={() => (banModalOpen = false)}>
	<ModalHeader
		title={m.users_banTitle({ username: data.profile.username ?? '' })}
		onClose={() => (banModalOpen = false)}
	/>
	<div class="space-y-4">
		<div>
			<label class="label" for="ban-duration">
				<span class="label-text">{m.users_banDurationLabel()}</span>
			</label>
			<select id="ban-duration" class="select-bordered select w-full" bind:value={banDuration}>
				{#each BAN_DURATIONS as duration (duration.value)}
					<option value={duration.value}>{duration.labelKey()}</option>
				{/each}
			</select>
		</div>
		<div>
			<label class="label" for="ban-reason">
				<span class="label-text">{m.users_banReasonLabel()}</span>
			</label>
			<input
				id="ban-reason"
				type="text"
				class="input-bordered input w-full"
				bind:value={banReason}
				placeholder={m.users_defaultBanReason()}
			/>
			<p class="mt-1 text-xs text-base-content/50">{m.users_banHint()}</p>
		</div>
	</div>
	<ModalFooter
		onCancel={() => (banModalOpen = false)}
		onSave={handleBan}
		saving={banningUser}
		saveLabel={m.users_banAction()}
	/>
</ModalWrapper>

<!-- Set password modal -->
<ModalWrapper open={passwordModalOpen} onClose={() => (passwordModalOpen = false)}>
	<ModalHeader
		title={m.users_setPasswordTitle({ username: data.profile.username ?? '' })}
		onClose={() => (passwordModalOpen = false)}
	/>
	<div class="space-y-4">
		<div>
			<label class="label" for="detail-new-password">
				<span class="label-text">{m.users_formPassword()}</span>
			</label>
			<div class="join w-full">
				<input
					id="detail-new-password"
					type="text"
					class="input-bordered input join-item w-full font-mono text-sm"
					bind:value={newPassword}
				/>
				<button type="button" class="btn join-item" onclick={generatePassword}>
					{m.users_generatePassword()}
				</button>
			</div>
			<p class="mt-1 text-xs text-base-content/50">{m.users_setPasswordHint()}</p>
		</div>
	</div>
	<ModalFooter
		onCancel={() => (passwordModalOpen = false)}
		onSave={handleSetPassword}
		saving={resettingPassword}
		saveLabel={m.users_setPasswordConfirm()}
	/>
</ModalWrapper>

<!-- Delete confirmation -->
<ConfirmationModal
	open={deleteModalOpen}
	onCancel={() => (deleteModalOpen = false)}
	onConfirm={handleDelete}
	loading={deletingUser}
	title={m.users_deleteTitle({ username: data.profile.username ?? '' })}
	message={m.users_deleteMessage({ username: data.profile.username ?? '' })}
	confirmLabel={m.action_delete()}
	confirmVariant="error"
/>
