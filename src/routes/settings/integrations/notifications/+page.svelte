<script lang="ts">
	import { goto, refreshAll } from '$app/navigation';
	import {
		Bell,
		CheckCircle2,
		Clock,
		Loader2,
		Pencil,
		Plus,
		Send,
		Trash2,
		XCircle
	} from '@lucide/svelte';
	import type { PageData } from './$types';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import { FormCheckbox, FormInput, FormSelect } from '#lib/components/ui/form/index.js';
	import {
		ConfirmationModal,
		ModalFooter,
		ModalHeader,
		ModalWrapper
	} from '#lib/components/ui/modal/index.js';
	import { SvelteSet } from 'svelte/reactivity';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import * as m from '#lib/paraglide/messages.js';
	import {
		createNotificationConnection,
		deleteNotificationConnection,
		testNotificationConnection,
		updateNotificationConnection,
		retryNotificationDelivery,
		testDraftNotification,
		type NotificationDelivery,
		type NotificationProvider,
		type NotificationTestResult
	} from '#lib/api/notifications.js';

	let { data }: { data: PageData } = $props();

	/** Row shape as the load returns it: the page never re-declares a parallel type. */
	type Connection = PageData['connections'][number];

	interface Draft {
		id: string | null;
		name: string;
		provider: string;
		enabled: boolean;
		events: string[];
		config: Record<string, unknown>;
	}

	/**
	 * Provider descriptors carry paraglide message *keys*; this map is the one
	 * place that turns them into text. A new provider field adds its key here.
	 */
	const MESSAGES: Record<string, () => string> = {
		notifications_field_webhookUrl: m.notifications_field_webhookUrl,
		notifications_field_method: m.notifications_field_method,
		notifications_field_authorization: m.notifications_field_authorization,
		notifications_help_authorization: m.notifications_help_authorization,
		notifications_option_post: m.notifications_option_post,
		notifications_option_put: m.notifications_option_put,
		notifications_field_discordWebhook: m.notifications_field_discordWebhook,
		notifications_help_discordWebhook: m.notifications_help_discordWebhook,
		notifications_field_discordUsername: m.notifications_field_discordUsername,
		notifications_field_pushoverToken: m.notifications_field_pushoverToken,
		notifications_help_pushoverToken: m.notifications_help_pushoverToken,
		notifications_field_pushoverUser: m.notifications_field_pushoverUser,
		notifications_help_pushoverUser: m.notifications_help_pushoverUser,
		notifications_field_pushoverPriority: m.notifications_field_pushoverPriority,
		notifications_field_pushoverSound: m.notifications_field_pushoverSound,
		notifications_help_pushoverSound: m.notifications_help_pushoverSound,
		notifications_option_prioritySilent: m.notifications_option_prioritySilent,
		notifications_option_priorityQuiet: m.notifications_option_priorityQuiet,
		notifications_option_priorityNormal: m.notifications_option_priorityNormal,
		notifications_option_priorityHigh: m.notifications_option_priorityHigh,
		notifications_field_ntfyServer: m.notifications_field_ntfyServer,
		notifications_help_ntfyServer: m.notifications_help_ntfyServer,
		notifications_field_ntfyTopic: m.notifications_field_ntfyTopic,
		notifications_help_ntfyTopic: m.notifications_help_ntfyTopic,
		notifications_field_ntfyToken: m.notifications_field_ntfyToken,
		notifications_help_ntfyToken: m.notifications_help_ntfyToken,
		notifications_field_ntfyPriority: m.notifications_field_ntfyPriority,
		notifications_option_priorityMin: m.notifications_option_priorityMin,
		notifications_option_priorityLow: m.notifications_option_priorityLow,
		notifications_option_priorityMax: m.notifications_option_priorityMax,
		notifications_help_secretBlankKeeps: m.notifications_help_secretBlankKeeps,
		notifications_event_grab: m.notifications_event_grab,
		notifications_event_import: m.notifications_event_import,
		notifications_event_upgrade: m.notifications_event_upgrade,
		notifications_event_request_pending: m.notifications_event_request_pending,
		notifications_event_request_approved: m.notifications_event_request_approved,
		notifications_event_request_declined: m.notifications_event_request_declined,
		notifications_event_request_available: m.notifications_event_request_available,
		notifications_event_request_failed: m.notifications_event_request_failed,
		notifications_event_request_expired: m.notifications_event_request_expired,
		notifications_event_task_failed: m.notifications_event_task_failed
	};

	function msg(key: string, fallback = ''): string {
		return MESSAGES[key]?.() ?? fallback;
	}

	function eventLabel(event: string): string {
		return msg(`notifications_event_${event}`, event);
	}

	function providerLabel(id: string): string {
		return data.providers.find((provider) => provider.id === id)?.label ?? id;
	}

	function defaultConfig(provider: NotificationProvider | undefined): Record<string, unknown> {
		const config: Record<string, unknown> = {};
		for (const field of provider?.fields ?? []) {
			if (field.type === 'boolean') config[field.key] = Boolean(field.default);
			else if (field.default !== undefined) config[field.key] = field.default;
			else config[field.key] = '';
		}
		return config;
	}

	function emptyDraft(): Draft {
		const provider = data.providers[0];
		return {
			id: null,
			name: '',
			provider: provider?.id ?? '',
			enabled: true,
			events: ['*'],
			config: defaultConfig(provider)
		};
	}

	let modalOpen = $state(false);
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let form = $state<Draft>(emptyDraft());
	let testingId = $state<string | null>(null);
	let deleteTarget = $state<Connection | null>(null);
	let deleting = $state(false);
	let togglingId = $state<string | null>(null);
	let retryingId = $state<string | null>(null);
	let testingDraft = $state(false);
	let draftTest = $state<NotificationTestResult | null>(null);
	let fieldErrors = $state<Record<string, string>>({});
	let filterConnection = $state('');

	// The filter lives in the URL (?connection=…), so a back/forward navigation
	// or a reload must move the select with it.
	$effect(() => {
		filterConnection = data.selectedConnectionId ?? '';
	});

	const activeProvider = $derived(
		data.providers.find((provider) => provider.id === form.provider) ?? data.providers[0]
	);
	const allEventsSelected = $derived(form.events.includes('*'));

	function openAdd() {
		form = emptyDraft();
		saveError = null;
		draftTest = null;
		fieldErrors = {};
		modalOpen = true;
	}

	function openEdit(connection: Connection) {
		form = {
			id: connection.id,
			name: connection.name,
			provider: connection.provider,
			enabled: connection.enabled,
			events: [...connection.events],
			config: {
				...defaultConfig(data.providers.find((p) => p.id === connection.provider)),
				...connection.config
			}
		};
		saveError = null;
		draftTest = null;
		fieldErrors = {};
		modalOpen = true;
	}

	function changeProvider(providerId: string) {
		const provider = data.providers.find((entry) => entry.id === providerId);
		form.provider = providerId;
		form.config = defaultConfig(provider);
	}

	function toggleAllEvents(checked: boolean) {
		// Unchecking the master clears the selection rather than leaving every
		// box ticked: "All events" is a selection, so turning it off must not
		// silently save the wildcard anyway.
		form.events = checked ? ['*'] : [];
	}

	function toggleEvent(event: string, checked: boolean) {
		const current = new SvelteSet(form.events.filter((entry) => entry !== '*'));
		if (checked) current.add(event);
		else current.delete(event);
		form.events = [...current];
	}

	function statusOf(connection: Connection): {
		label: string;
		cls: string;
		detail: string | null;
	} {
		if (!connection.enabled) {
			return { label: m.notifications_statusDisabled(), cls: 'badge-ghost', detail: null };
		}
		if (connection.disabledUntil && Date.parse(connection.disabledUntil) > Date.now()) {
			return {
				label: m.notifications_statusBackoff(),
				cls: 'badge-warning',
				detail: m.notifications_backoffUntil({ time: formatTime(connection.disabledUntil) })
			};
		}
		if (connection.consecutiveFailures > 0) {
			return {
				label: m.notifications_statusFailing(),
				cls: 'badge-error',
				detail: connection.lastError
			};
		}
		if (connection.lastSuccessAt) {
			return {
				label: m.notifications_statusHealthy(),
				cls: 'badge-success',
				detail: m.notifications_lastSuccess({ time: formatTime(connection.lastSuccessAt) })
			};
		}
		return { label: m.notifications_statusNever(), cls: 'badge-ghost', detail: null };
	}

	function formatTime(value: string | null): string {
		if (!value) return '—';
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
	}

	function validateDraft(): boolean {
		const errors: Record<string, string> = {};
		if (!form.name.trim()) errors.name = m.notifications_nameRequired();
		if (form.events.length === 0) errors.events = m.notifications_eventsRequired();
		for (const field of activeProvider?.fields ?? []) {
			const value = String(form.config[field.key] ?? '').trim();
			// A stored secret is never round-tripped, so a blank secret field on
			// an existing connection is "keep the current one", not "missing".
			const storedSecret = field.secret === true && form.id !== null;
			if (field.required && !value && !storedSecret) {
				errors[field.key] = m.notifications_fieldRequired();
			}
			if (field.type === 'url' && value && !/^https?:\/\/[^\s/]+/i.test(value)) {
				errors[field.key] = m.notifications_urlInvalid();
			}
		}
		fieldErrors = errors;
		return Object.keys(errors).length === 0;
	}

	/** Tests the draft config, before it is saved. */
	async function runDraftTest() {
		if (!validateDraft()) return;
		testingDraft = true;
		draftTest = null;
		try {
			const result = await testDraftNotification({
				provider: form.provider,
				connectionId: form.id ?? undefined,
				config: form.config
			});
			draftTest = result;
			if (result.ok) toasts.success(m.notifications_testSuccess({ name: form.name }));
			else toasts.error(result.error ?? m.notifications_testFailed({ name: form.name }));
		} catch (error) {
			draftTest = { ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			testingDraft = false;
		}
	}

	async function toggleEnabled(connection: Connection) {
		togglingId = connection.id;
		try {
			await updateNotificationConnection(connection.id, { enabled: !connection.enabled });
			toasts.success(
				connection.enabled
					? m.notifications_disabledToast({ name: connection.name })
					: m.notifications_enabledToast({ name: connection.name })
			);
			await refreshAll();
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : String(error));
		} finally {
			togglingId = null;
		}
	}

	async function retryDelivery(delivery: NotificationDelivery) {
		retryingId = delivery.id;
		try {
			const result = await retryNotificationDelivery(delivery.id);
			if (result.ok) toasts.success(m.notifications_retrySuccess());
			else
				toasts.error(
					m.notifications_retryFailed({ error: result.error ?? m.notifications_deliveryFailed() })
				);
			await refreshAll();
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : String(error));
		} finally {
			retryingId = null;
		}
	}

	function changeFilter(value: string) {
		filterConnection = value;
		const url = new URL(window.location.href);
		if (value) url.searchParams.set('connection', value);
		else url.searchParams.delete('connection');
		void goto(url.pathname + url.search, {
			replaceState: true,
			invalidateAll: true
		});
	}

	async function save() {
		saveError = null;
		if (!validateDraft()) {
			saveError = m.notifications_errorRequiredFields();
			return;
		}
		saving = true;
		saveError = null;
		const payload = {
			name: form.name.trim(),
			provider: form.provider,
			enabled: form.enabled,
			events: form.events,
			config: form.config
		};
		try {
			if (form.id) await updateNotificationConnection(form.id, payload);
			else await createNotificationConnection(payload);
			modalOpen = false;
			toasts.success(m.notifications_saved());
			await refreshAll();
		} catch (error) {
			saveError = error instanceof Error ? error.message : String(error);
		} finally {
			saving = false;
		}
	}

	async function runTest(connection: Connection) {
		testingId = connection.id;
		try {
			const result = await testNotificationConnection(connection.id);
			if (result.ok) toasts.success(m.notifications_testSuccess({ name: connection.name }));
			else toasts.error(result.error ?? m.notifications_testFailed({ name: connection.name }));
			await refreshAll();
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : String(error));
		} finally {
			testingId = null;
		}
	}

	async function confirmDelete() {
		if (!deleteTarget) return;
		deleting = true;
		try {
			await deleteNotificationConnection(deleteTarget.id);
			deleteTarget = null;
			toasts.success(m.notifications_deleted());
			await refreshAll();
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : String(error));
		} finally {
			deleting = false;
		}
	}
</script>

<SettingsPage title={m.notifications_title()} subtitle={m.notifications_subtitle()}>
	{#snippet actions()}
		<button class="btn gap-1.5 btn-primary btn-sm" onclick={openAdd}>
			<Plus class="h-4 w-4" />
			{m.notifications_addConnection()}
		</button>
	{/snippet}

	<div class="card border border-base-300 bg-base-100">
		<div class="card-body p-0">
			{#if data.connections.length === 0}
				<div class="flex flex-col items-center gap-2 px-6 py-12 text-center">
					<Bell class="h-8 w-8 text-base-content/30" />
					<p class="font-medium">{m.notifications_empty()}</p>
					<p class="max-w-md text-sm text-base-content/60">{m.notifications_emptyHint()}</p>
					<button class="btn mt-2 gap-1.5 btn-primary btn-sm" onclick={openAdd}>
						<Plus class="h-4 w-4" />
						{m.notifications_addConnection()}
					</button>
				</div>
			{:else}
				<div class="overflow-x-auto">
					<table class="table table-sm">
						<thead>
							<tr>
								<th>{m.notifications_colName()}</th>
								<th>{m.notifications_colProvider()}</th>
								<th class="hidden md:table-cell">{m.notifications_colEvents()}</th>
								<th>{m.notifications_colStatus()}</th>
								<th class="text-right">{m.notifications_colActions()}</th>
							</tr>
						</thead>
						<tbody>
							{#each data.connections as connection (connection.id)}
								{@const status = statusOf(connection)}
								<tr>
									<td>
										<input
											type="checkbox"
											class="toggle toggle-primary toggle-sm"
											checked={connection.enabled}
											disabled={togglingId === connection.id}
											aria-label={m.notifications_fieldEnabled()}
											onchange={() => toggleEnabled(connection)}
										/>
									</td>
									<td>
										<div class="font-medium">{connection.name}</div>
										{#if status.detail}
											<div
												class="max-w-xs truncate text-xs text-base-content/60"
												title={status.detail}
											>
												{status.detail}
											</div>
										{/if}
									</td>
									<td>
										<span class="badge badge-ghost badge-sm"
											>{providerLabel(connection.provider)}</span
										>
									</td>
									<td class="hidden md:table-cell">
										{#if connection.events.includes('*')}
											<span class="badge badge-outline badge-sm">{m.notifications_allEvents()}</span
											>
										{:else}
											<div class="flex flex-wrap gap-1">
												{#each connection.events as event (event)}
													<span class="badge badge-ghost badge-sm">{eventLabel(event)}</span>
												{/each}
											</div>
										{/if}
									</td>
									<td>
										<span class="badge badge-sm {status.cls}">{status.label}</span>
									</td>
									<td class="text-right">
										<div class="flex justify-end gap-1">
											<button
												class="btn gap-1 btn-ghost btn-xs"
												disabled={testingId === connection.id}
												onclick={() => runTest(connection)}
												title={m.notifications_actionTest()}
											>
												{#if testingId === connection.id}
													<Loader2 class="h-3.5 w-3.5 animate-spin" />
												{:else}
													<Send class="h-3.5 w-3.5" />
												{/if}
												<span class="hidden sm:inline">{m.notifications_actionTest()}</span>
											</button>
											<button
												class="btn gap-1 btn-ghost btn-xs"
												onclick={() => openEdit(connection)}
												title={m.action_edit()}
											>
												<Pencil class="h-3.5 w-3.5" />
												<span class="hidden sm:inline">{m.action_edit()}</span>
											</button>
											<button
												class="btn btn-ghost text-error btn-xs"
												onclick={() => (deleteTarget = connection)}
												title={m.action_delete()}
											>
												<Trash2 class="h-3.5 w-3.5" />
											</button>
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	</div>

	<div class="card border border-base-300 bg-base-100">
		<div class="card-body gap-3">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<div class="flex items-center gap-2">
					<Clock class="h-4 w-4 text-base-content/60" />
					<h2 class="font-semibold">{m.notifications_recentDeliveries()}</h2>
				</div>
				{#if data.connections.length > 1}
					<select
						class="select-bordered select w-56 select-xs"
						aria-label={m.notifications_filterLabel()}
						value={filterConnection}
						onchange={(event) => changeFilter((event.currentTarget as HTMLSelectElement).value)}
					>
						<option value="">{m.notifications_filterAll()}</option>
						{#each data.connections as connection (connection.id)}
							<option value={connection.id}>{connection.name}</option>
						{/each}
					</select>
				{/if}
			</div>
			{#if data.deliveries.length === 0}
				<p class="text-sm text-base-content/60">{m.notifications_deliveriesEmpty()}</p>
			{:else}
				<div class="overflow-x-auto">
					<table class="table table-xs">
						<thead>
							<tr>
								<th>{m.notifications_colWhen()}</th>
								<th>{m.notifications_colName()}</th>
								<th>{m.notifications_colEvent()}</th>
								<th>{m.notifications_colResult()}</th>
							</tr>
						</thead>
						<tbody>
							{#each data.deliveries as delivery (delivery.id)}
								<tr>
									<td class="whitespace-nowrap text-base-content/70"
										>{formatTime(delivery.createdAt)}</td
									>
									<td>
										{delivery.connectionName ?? '—'}
										<span class="text-xs text-base-content/50"
											>{delivery.connectionProvider ?? ''}</span
										>
									</td>
									<td>{eventLabel(delivery.event)}</td>
									<td>
										{#if delivery.ok}
											<span class="inline-flex items-center gap-1 text-success">
												<CheckCircle2 class="h-3.5 w-3.5" />
												{m.notifications_deliveryOk()}
												{#if delivery.durationMs !== null}
													<span class="text-base-content/50">{delivery.durationMs} ms</span>
												{/if}
											</span>
										{:else}
											<span class="inline-flex items-center gap-1 text-error">
												<XCircle class="h-3.5 w-3.5" />
												<span class="max-w-md truncate" title={delivery.error ?? ''}>
													{delivery.error ?? m.notifications_deliveryFailed()}
												</span>
												<button
													class="btn gap-1 btn-ghost btn-xs"
													disabled={retryingId === delivery.id}
													onclick={() => retryDelivery(delivery)}
												>
													{#if retryingId === delivery.id}
														<Loader2 class="h-3 w-3 animate-spin" />
													{/if}
													{m.notifications_actionRetry()}
												</button>
											</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	</div>
</SettingsPage>

<ModalWrapper open={modalOpen} onClose={() => (modalOpen = false)} maxWidth="2xl">
	<ModalHeader
		title={form.id ? m.notifications_modalEditTitle() : m.notifications_modalAddTitle()}
		onClose={() => (modalOpen = false)}
	/>

	<div class="space-y-4">
		<FormInput
			label={m.notifications_fieldName()}
			id="notification-name"
			value={form.name}
			placeholder={m.notifications_placeholderName()}
			required
			error={fieldErrors.name}
			onchange={(value) => (form.name = String(value))}
		/>

		<FormSelect
			label={m.notifications_fieldProvider()}
			id="notification-provider"
			value={form.provider}
			options={data.providers.map((provider) => ({ value: provider.id, label: provider.label }))}
			onchange={(value) => changeProvider(String(value))}
		/>

		<FormCheckbox
			label={m.notifications_fieldEnabled()}
			checked={form.enabled}
			variant="toggle"
			onchange={(checked) => (form.enabled = checked)}
		/>

		<div class="divider my-1 text-xs text-base-content/50 uppercase">
			{m.notifications_configSection()}
		</div>

		{#each activeProvider?.fields ?? [] as field (field.key)}
			{#if field.type === 'select'}
				<FormSelect
					label={msg(field.labelKey, field.key)}
					id={`notification-field-${field.key}`}
					value={String(form.config[field.key] ?? '')}
					options={(field.options ?? []).map((option) => ({
						value: option.value,
						label: msg(option.labelKey, option.value)
					}))}
					helpText={field.helpKey ? msg(field.helpKey) : undefined}
					required={field.required}
					error={fieldErrors[field.key]}
					onchange={(value) => (form.config[field.key] = String(value))}
				/>
			{:else if field.type === 'boolean'}
				<FormCheckbox
					label={msg(field.labelKey, field.key)}
					checked={Boolean(form.config[field.key])}
					variant="toggle"
					onchange={(checked) => (form.config[field.key] = checked)}
				/>
			{:else}
				<FormInput
					label={msg(field.labelKey, field.key)}
					id={`notification-field-${field.key}`}
					type={field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'}
					value={String(form.config[field.key] ?? '')}
					placeholder={field.placeholder}
					required={field.required}
					error={fieldErrors[field.key]}
					helpText={field.secret && form.id !== null
						? msg('notifications_help_secretBlankKeeps')
						: field.helpKey
							? msg(field.helpKey)
							: undefined}
					onchange={(value) => (form.config[field.key] = String(value))}
				/>
			{/if}
		{/each}

		<div class="divider my-1 text-xs text-base-content/50 uppercase">
			{m.notifications_fieldEvents()}
		</div>

		<FormCheckbox
			label={m.notifications_allEvents()}
			description={m.notifications_helpEvents()}
			checked={allEventsSelected}
			onchange={(checked) => toggleAllEvents(checked)}
		/>

		{#if fieldErrors.events}
			<p class="text-xs text-error">{fieldErrors.events}</p>
		{/if}

		<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
			{#each data.events as event (event)}
				<FormCheckbox
					label={eventLabel(event)}
					checked={allEventsSelected || form.events.includes(event)}
					disabled={allEventsSelected}
					onchange={(checked) => toggleEvent(event, checked)}
				/>
			{/each}
		</div>

		{#if saveError}
			<div class="alert text-sm alert-error">{saveError}</div>
		{/if}

		{#if draftTest}
			<div class="alert text-sm {draftTest.ok ? 'alert-success' : 'alert-error'}">
				{draftTest.ok
					? m.notifications_testSuccess({ name: form.name || activeProvider?.label || '' })
					: (draftTest.error ?? m.notifications_deliveryFailed())}
			</div>
		{/if}

		<div class="flex flex-wrap items-center gap-3 pt-1">
			<button class="btn gap-1.5 btn-outline btn-sm" onclick={runDraftTest} disabled={testingDraft}>
				{#if testingDraft}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<Send class="h-4 w-4" />
				{/if}
				{m.notifications_actionSendTest()}
			</button>
			<span class="text-xs text-base-content/60">{m.notifications_helpDraftTest()}</span>
		</div>
	</div>

	<ModalFooter onCancel={() => (modalOpen = false)} onSave={save} {saving} />
</ModalWrapper>

<ConfirmationModal
	open={deleteTarget !== null}
	title={m.notifications_deleteTitle()}
	message={m.notifications_deleteMessage({ name: deleteTarget?.name ?? '' })}
	confirmLabel={m.action_delete()}
	confirmVariant="error"
	loading={deleting}
	onConfirm={confirmDelete}
	onCancel={() => (deleteTarget = null)}
/>
