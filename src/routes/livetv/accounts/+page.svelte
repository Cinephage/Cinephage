<script lang="ts">
	import { Plus, RefreshCw, Loader2 } from '@lucide/svelte';
	import { LiveTvAccountTable, LiveTvAccountModal } from '#lib/components/livetv/index.js';
	import { toFriendlyLiveTvTestError } from '#lib/livetv/errorMessages.js';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import type { LiveTvAccount, LiveTvAccountTestResult } from '#lib/types/livetv.js';
	import type { FormData, TestConfig } from '#lib/components/livetv/LiveTvAccountModal.svelte';
	import { createSSE } from '#lib/sse/index.js';
	import { resolvePath } from '#lib/utils/routing.js';
	import {
		buildAccountRequestBody,
		buildAccountTestRequestBody
	} from '#lib/livetv/accountFormPayload.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import type { AccountStreamEvents } from '#lib/types/sse/events/livetv-account-events.js';
	import { layoutState, deriveMobileSseStatus } from '#lib/layout.svelte.js';
	import * as m from '#lib/paraglide/messages.js';
	import {
		getAccounts,
		createAccount,
		updateAccount,
		deleteAccount,
		testAccount,
		syncChannels,
		testAccountConfig
	} from '#lib/api/index.js';

	// State
	let accounts = $state<LiveTvAccount[]>([]);
	let loading = $state(true);
	let refreshing = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);

	// Modal state
	let modalOpen = $state(false);
	let modalMode = $state<'add' | 'edit'>('add');
	let editingAccount = $state<LiveTvAccount | null>(null);
	let modalError = $state<string | null>(null);
	let deleteConfirmOpen = $state(false);

	// Testing state
	let testingId = $state<string | null>(null);

	// Syncing state
	let syncingId = $state<string | null>(null);

	// SSE Connection - internally handles browser/SSR
	const sse = createSSE<AccountStreamEvents>(resolvePath('/api/livetv/accounts/stream'), {
		'accounts:initial': (payload) => {
			accounts = payload.accounts || [];
			loading = false;
		},
		'account:created': (payload) => {
			accounts = payload.accounts || [];
		},
		'account:updated': (payload) => {
			accounts = payload.accounts || [];
		},
		'account:deleted': (payload) => {
			accounts = payload.accounts || [];
		},
		'channels:syncStarted': (payload) => {
			syncingId = payload.accountId;
		},
		'channels:syncCompleted': (payload) => {
			if (syncingId === payload.accountId) {
				syncingId = null;
			}
		},
		'channels:syncFailed': (payload) => {
			if (syncingId === payload.accountId) {
				syncingId = null;
			}
		}
	});

	$effect(() => {
		layoutState.setMobileSseStatus(deriveMobileSseStatus(sse));
		return () => {
			layoutState.clearMobileSseStatus();
		};
	});

	// Load accounts on mount
	$effect(() => {
		loadAccounts();
	});

	async function loadAccounts(options: { foreground?: boolean } = {}) {
		const { foreground = true } = options;
		if (foreground) {
			loading = true;
			error = null;
		}

		try {
			const data = await getAccounts();
			accounts = data.accounts;
		} catch (e) {
			error = e instanceof Error ? e.message : m.livetv_accounts_failedToLoadAccounts();
		} finally {
			if (foreground) {
				loading = false;
			}
		}
	}

	async function refreshAccounts() {
		refreshing = true;
		await loadAccounts({ foreground: false });
		refreshing = false;
	}

	function openAddModal() {
		modalMode = 'add';
		editingAccount = null;
		modalError = null;
		modalOpen = true;
	}

	function openEditModal(account: LiveTvAccount) {
		modalMode = 'edit';
		editingAccount = account;
		modalError = null;
		modalOpen = true;
	}

	function closeModal() {
		modalOpen = false;
		editingAccount = null;
		modalError = null;
		deleteConfirmOpen = false;
	}

	async function handleSave(data: FormData) {
		saving = true;
		modalError = null;

		try {
			// Build request body based on provider type
			const body = buildAccountRequestBody(data, modalMode);

			if (modalMode === 'add') {
				// @ts-expect-error body shape matches expected type at runtime
				await createAccount(body);
			} else {
				await updateAccount(editingAccount!.id, body);
			}

			closeModal();
			void loadAccounts({ foreground: false });
		} catch (e) {
			modalError = e instanceof Error ? e.message : m.livetv_accounts_failedToSaveAccount();
		} finally {
			saving = false;
		}
	}

	function handleDelete() {
		if (!editingAccount) return;
		deleteConfirmOpen = true;
	}

	function closeDeleteConfirm() {
		if (saving) return;
		deleteConfirmOpen = false;
	}

	function getTestSummary(result: LiveTvAccountTestResult): string | undefined {
		if (!result.profile) return undefined;

		const parts = [
			m.livetv_accounts_testSummaryChannels({
				count: result.profile.channelCount.toLocaleString()
			}),
			m.livetv_accounts_testSummaryCategories({
				count: result.profile.categoryCount.toLocaleString()
			})
		];

		const epgStatus = result.profile.epg?.status;
		if (epgStatus === 'reachable') {
			parts.push(m.livetv_accounts_epgReachable());
		} else if (epgStatus === 'unreachable') {
			const epgError = result.profile.epg?.error;
			parts.push(
				epgError
					? m.livetv_accounts_epgUnreachableWithError({ error: epgError })
					: m.livetv_accounts_epgUnreachable()
			);
		} else if (epgStatus === 'not_configured') {
			parts.push(m.livetv_accounts_epgNotConfigured());
		}

		return parts.join(' \u2022 ');
	}

	async function confirmDelete() {
		if (!editingAccount) return;

		saving = true;
		modalError = null;

		try {
			await deleteAccount(editingAccount.id);

			await loadAccounts({ foreground: false });
			deleteConfirmOpen = false;
			closeModal();
		} catch (e) {
			modalError = e instanceof Error ? e.message : m.livetv_accounts_failedToDeleteAccount();
		} finally {
			saving = false;
		}
	}

	async function handleToggle(account: LiveTvAccount) {
		try {
			await updateAccount(account.id, { enabled: !account.enabled });

			await loadAccounts({ foreground: false });
		} catch (e) {
			toasts.error(m.livetv_accounts_failedToUpdateAccount(), {
				description: e instanceof Error ? e.message : m.livetv_accounts_failedToUpdateAccount()
			});
		}
	}

	async function handleTest(account: LiveTvAccount) {
		testingId = account.id;

		try {
			const payload = (await testAccount(account.id)) as {
				success?: boolean;
				error?: string;
				result?: LiveTvAccountTestResult;
			} & LiveTvAccountTestResult;

			const rawTestResult =
				payload?.result && typeof payload.result.success === 'boolean'
					? payload.result
					: payload && typeof payload.success === 'boolean'
						? payload
						: null;

			if (!rawTestResult) {
				throw new Error(m.livetv_accounts_invalidTestResponse());
			}
			const testResult = rawTestResult.success
				? rawTestResult
				: {
						...rawTestResult,
						error: toFriendlyLiveTvTestError(rawTestResult.error, account.providerType)
					};

			const now = new Date().toISOString();
			accounts = accounts.map((existing) => {
				if (existing.id !== account.id) return existing;

				return {
					...existing,
					lastTestedAt: now,
					lastTestSuccess: testResult.success,
					lastTestError: testResult.success ? null : (testResult.error ?? 'Unknown error'),
					...(testResult.success && testResult.profile
						? {
								playbackLimit: testResult.profile.playbackLimit,
								channelCount: testResult.profile.channelCount,
								categoryCount: testResult.profile.categoryCount,
								expiresAt: testResult.profile.expiresAt,
								serverTimezone: testResult.profile.serverTimezone
							}
						: {})
				};
			});

			if (testResult.success) {
				toasts.success(m.livetv_accounts_connectionTestPassed({ name: account.name }), {
					description: getTestSummary(testResult)
				});
			} else {
				toasts.error(m.livetv_accounts_connectionTestFailed({ name: account.name }), {
					description: testResult.error || m.livetv_accounts_unknownTestFailure()
				});
			}
		} catch (e) {
			toasts.error(m.livetv_accounts_connectionTestFailed({ name: account.name }), {
				description: toFriendlyLiveTvTestError(
					e instanceof Error ? e.message : m.livetv_accounts_failedToTestAccount(),
					account.providerType
				)
			});
		} finally {
			testingId = null;
		}
	}

	async function handleSync(account: LiveTvAccount) {
		syncingId = account.id;

		try {
			await syncChannels({ accountIds: [account.id] });

			await loadAccounts({ foreground: false });
		} catch (e) {
			toasts.error(m.livetv_accounts_failedToSyncAccount(), {
				description: e instanceof Error ? e.message : m.livetv_accounts_failedToSyncAccount()
			});
		} finally {
			syncingId = null;
		}
	}

	async function handleTestConfig(config: TestConfig): Promise<LiveTvAccountTestResult> {
		const body = buildAccountTestRequestBody(config);

		try {
			const response = await testAccountConfig(body as Record<string, unknown>);

			if (!response.success) {
				return {
					success: false,
					error: toFriendlyLiveTvTestError(
						typeof response?.error === 'string'
							? response.error
							: m.livetv_accounts_failedToTestConfig(),
						config.providerType
					)
				};
			}

			const result = response as Record<string, unknown>;

			// API currently returns { success, result }, but keep backward compatibility
			// in case the endpoint returns LiveTvAccountTestResult directly.
			if (
				result?.result &&
				typeof (result.result as LiveTvAccountTestResult).success === 'boolean'
			) {
				const testResult = result.result as LiveTvAccountTestResult;
				return testResult.success
					? testResult
					: {
							...testResult,
							error: toFriendlyLiveTvTestError(testResult.error, config.providerType)
						};
			}

			if (typeof result?.success === 'boolean') {
				const testResult = result as unknown as LiveTvAccountTestResult;
				return testResult.success
					? testResult
					: {
							...testResult,
							error: toFriendlyLiveTvTestError(testResult.error, config.providerType)
						};
			}

			return {
				success: false,
				error: m.livetv_accounts_invalidTestEndpointResponse()
			};
		} catch (error) {
			return {
				success: false,
				error: toFriendlyLiveTvTestError(
					error instanceof Error ? error.message : m.livetv_accounts_failedToTestConfig(),
					config.providerType
				)
			};
		}
	}
</script>

<svelte:head>
	<title>{m.livetv_accounts_pageTitle()}</title>
</svelte:head>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
		<div>
			<h1 class="text-2xl font-bold">{m.livetv_accounts_heading()}</h1>
			<p class="mt-1 text-base-content/60">{m.livetv_accounts_subtitle()}</p>
		</div>
		<div class="flex w-full items-center gap-2 sm:w-auto">
			<button
				class="btn btn-ghost btn-sm"
				onclick={refreshAccounts}
				disabled={loading || refreshing}
				title={m.action_refresh()}
			>
				{#if refreshing}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<RefreshCw class="h-4 w-4" />
				{/if}
			</button>
			<button class="btn flex-1 btn-primary btn-sm sm:flex-none" onclick={openAddModal}>
				<Plus class="h-4 w-4" />
				{m.livetv_accounts_addAccount()}
			</button>
		</div>
	</div>

	<!-- Content -->
	{#if loading}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="h-8 w-8 animate-spin text-primary" />
		</div>
	{:else if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-ghost btn-sm" onclick={() => loadAccounts()}>{m.common_retry()}</button
			>
		</div>
	{:else}
		<LiveTvAccountTable
			{accounts}
			onEdit={openEditModal}
			onDelete={(account) => {
				editingAccount = account;
				handleDelete();
			}}
			onToggle={handleToggle}
			onTest={handleTest}
			onSync={handleSync}
			{testingId}
			{syncingId}
		/>
	{/if}
</div>

<!-- Account Modal -->
<LiveTvAccountModal
	open={modalOpen}
	mode={modalMode}
	account={editingAccount}
	{saving}
	error={modalError}
	onClose={closeModal}
	onSave={handleSave}
	onDelete={handleDelete}
	onTest={handleTestConfig}
/>

<ConfirmationModal
	open={deleteConfirmOpen}
	title={m.livetv_accounts_deleteAccountTitle()}
	messagePrefix={m.livetv_accounts_deleteAccountMessagePrefix()}
	messageEmphasis={editingAccount?.name ?? 'this account'}
	messageSuffix={m.livetv_accounts_deleteAccountMessageSuffix()}
	confirmLabel={m.common_delete()}
	confirmVariant="error"
	loading={saving}
	onConfirm={confirmDelete}
	onCancel={closeDeleteConfirm}
/>
