<script lang="ts">
	import { X, Loader2, Search, ChevronRight, ChevronLeft, Radio } from '@lucide/svelte';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import * as m from '#lib/paraglide/messages.js';
	import {
		getPortals,
		detectPortal as detectPortalApi,
		createPortal,
		scanPortal as scanPortalApi
	} from '#lib/api/livetv.js';

	interface StalkerPortal {
		id: string;
		name: string;
		url: string;
		endpoint: string | null;
		lastScannedAt: string | null;
		enabled: boolean;
	}

	interface Props {
		open: boolean;
		onClose: () => void;
		onScanStarted: (workerId: string, portalId: string) => void;
	}

	let { open, onClose, onScanStarted }: Props = $props();

	// Steps
	type Step = 'portal' | 'config';
	let currentStep = $state<Step>('portal');

	// Portal state
	let portals = $state<StalkerPortal[]>([]);
	let loadingPortals = $state(false);
	let selectedPortalId = $state<string | null>(null);
	let creatingPortal = $state(false);
	let newPortalUrl = $state('');
	let newPortalName = $state('');
	let detectingPortal = $state(false);
	let portalError = $state<string | null>(null);

	// Scan config state
	type ScanType = 'random' | 'sequential' | 'import';
	let scanType = $state<ScanType>('random');

	// Random scan options
	let macPrefix = $state('00:1A:79');
	let macCount = $state(100);

	// Sequential scan options
	let macRangeStart = $state('');
	let macRangeEnd = $state('');

	// Import scan options
	let importedMacs = $state('');

	// Rate limit
	let rateLimit = $state(500);

	// Starting scan
	let startingScan = $state(false);
	let scanError = $state<string | null>(null);

	// MAC prefixes from MacGenerator
	const macPrefixes = [
		{ prefix: '00:1A:79', name: m.livetv_portalScanModal_magnumSemiconductors() },
		{ prefix: '00:2A:01', name: m.livetv_portalScanModal_stbDevice() },
		{ prefix: '00:1B:79', name: m.livetv_portalScanModal_stbDevice() },
		{ prefix: '00:2A:79', name: m.livetv_portalScanModal_stbDevice() },
		{ prefix: '00:A1:79', name: m.livetv_portalScanModal_stbDevice() },
		{ prefix: 'D4:CF:F9', name: m.livetv_portalScanModal_stbDevice() },
		{ prefix: '33:44:CF', name: m.livetv_portalScanModal_stbDevice() },
		{ prefix: '10:27:BE', name: m.livetv_portalScanModal_stbDevice() },
		{ prefix: 'A0:BB:3E', name: m.livetv_portalScanModal_stbDevice() },
		{ prefix: '55:93:EA', name: m.livetv_portalScanModal_stbDevice() },
		{ prefix: '04:D6:AA', name: m.livetv_portalScanModal_stbDevice() },
		{ prefix: '11:33:01', name: m.livetv_portalScanModal_stbDevice() },
		{ prefix: '00:1C:19', name: m.livetv_portalScanModal_stbDevice() },
		{ prefix: '1A:00:6A', name: m.livetv_portalScanModal_stbDevice() },
		{ prefix: '1A:00:FB', name: m.livetv_portalScanModal_stbDevice() }
	];

	// Derived
	const selectedPortal = $derived(portals.find((p) => p.id === selectedPortalId));
	const canProceedToConfig = $derived(
		selectedPortalId !== null || (newPortalUrl.trim() && newPortalName.trim())
	);

	const canStartScan = $derived(() => {
		if (!selectedPortalId && !newPortalUrl.trim()) return false;

		switch (scanType) {
			case 'random':
				return macCount > 0 && macCount <= 10000;
			case 'sequential':
				return isValidMac(macRangeStart) && isValidMac(macRangeEnd);
			case 'import':
				return importedMacs.trim().length > 0;
			default:
				return false;
		}
	});

	// Reset state when modal opens
	$effect(() => {
		if (open) {
			currentStep = 'portal';
			selectedPortalId = null;
			creatingPortal = false;
			newPortalUrl = '';
			newPortalName = '';
			portalError = null;
			scanType = 'random';
			macPrefix = '00:1A:79';
			macCount = 100;
			macRangeStart = '';
			macRangeEnd = '';
			importedMacs = '';
			rateLimit = 500;
			scanError = null;
			loadPortals();
		}
	});

	async function loadPortals() {
		loadingPortals = true;
		portalError = null;

		try {
			const result = await getPortals();
			if (!result.success)
				throw new Error(result.error || m.livetv_portalScanModal_failedToLoadPortals());
			portals = result.portals || [];
		} catch (e) {
			portalError = e instanceof Error ? e.message : m.livetv_portalScanModal_failedToLoadPortals();
		} finally {
			loadingPortals = false;
		}
	}

	async function detectPortal() {
		if (!newPortalUrl.trim()) return;

		detectingPortal = true;
		portalError = null;

		try {
			await detectPortalApi(newPortalUrl.trim());

			if (!newPortalName.trim()) {
				try {
					const url = new URL(newPortalUrl);
					newPortalName = url.hostname;
				} catch {
					newPortalName = m.livetv_portalScanModal_newPortal();
				}
			}
		} catch (e) {
			portalError =
				e instanceof Error ? e.message : m.livetv_portalScanModal_failedToDetectPortal();
		} finally {
			detectingPortal = false;
		}
	}

	function isValidMac(mac: string): boolean {
		const macRegex = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
		return macRegex.test(mac);
	}

	function formatMacAddress(value: string): string {
		const hex = value.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
		const parts = hex.match(/.{1,2}/g) || [];
		return parts.slice(0, 6).join(':');
	}

	function handleMacInput(e: Event, which: 'start' | 'end') {
		const input = e.target as HTMLInputElement;
		const formatted = formatMacAddress(input.value);
		if (which === 'start') {
			macRangeStart = formatted;
		} else {
			macRangeEnd = formatted;
		}
	}

	async function handleStartScan() {
		startingScan = true;
		scanError = null;

		try {
			let portalId = selectedPortalId;

			if (!portalId && newPortalUrl.trim()) {
				const newPortal = await createPortal({
					name: newPortalName.trim(),
					url: newPortalUrl.trim(),
					enabled: true
				});

				portalId = newPortal.id;
			}

			if (!portalId) {
				throw new Error('No portal selected');
			}

			const scanRequest: Record<string, unknown> = {
				type: scanType,
				rateLimit
			};

			if (scanType === 'random') {
				scanRequest.macPrefix = macPrefix;
				scanRequest.macCount = macCount;
			} else if (scanType === 'sequential') {
				scanRequest.macRangeStart = macRangeStart;
				scanRequest.macRangeEnd = macRangeEnd;
			} else if (scanType === 'import') {
				scanRequest.macs = importedMacs
					.split(/[\n,;]+/)
					.map((m) => m.trim())
					.filter((m) => m.length > 0);
			}

			const scanData = await scanPortalApi(portalId, scanRequest);
			onScanStarted(scanData.workerId, portalId);
		} catch (e) {
			scanError = e instanceof Error ? e.message : m.livetv_portalScanModal_failedToStartScan();
		} finally {
			startingScan = false;
		}
	}
</script>

<ModalWrapper {open} {onClose} maxWidth="2xl" labelledBy="portal-scan-modal-title">
	<!-- Header -->
	<div class="mb-6 flex items-center justify-between">
		<div class="flex items-center gap-3">
			<div class="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
				<Search class="h-5 w-5 text-primary" />
			</div>
			<div>
				<h3 id="portal-scan-modal-title" class="text-xl font-bold">
					{m.livetv_portalScanModal_title()}
				</h3>
				<div class="mt-1 flex items-center gap-2 text-sm text-base-content/60">
					<span class="badge badge-sm {currentStep === 'portal' ? 'badge-primary' : 'badge-ghost'}">
						{m.livetv_portalScanModal_stepPortal()}
					</span>
					<ChevronRight class="h-3 w-3" />
					<span class="badge badge-sm {currentStep === 'config' ? 'badge-primary' : 'badge-ghost'}">
						{m.livetv_portalScanModal_stepConfig()}
					</span>
				</div>
			</div>
		</div>
		<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>
			<X class="h-4 w-4" />
		</button>
	</div>

	<!-- Step 1: Portal Selection -->
	{#if currentStep === 'portal'}
		<div class="space-y-4">
			{#if loadingPortals}
				<div class="flex items-center justify-center py-8">
					<Loader2 class="h-6 w-6 animate-spin text-primary" />
				</div>
			{:else}
				<!-- Existing Portals -->
				{#if portals.length > 0}
					<div class="space-y-2">
						<div class="label py-1">
							<span class="label-text font-medium"
								>{m.livetv_portalScanModal_selectExistingPortal()}</span
							>
						</div>
						<div class="space-y-2">
							{#each portals as portal (portal.id)}
								<button
									class="w-full rounded-lg border p-3 text-left transition-colors {selectedPortalId ===
									portal.id
										? 'border-primary bg-primary/5'
										: 'border-base-300 hover:border-primary/50'}"
									onclick={() => {
										selectedPortalId = portal.id;
										creatingPortal = false;
									}}
								>
									<div class="flex items-center justify-between">
										<div>
											<div class="font-medium">{portal.name}</div>
											<div class="text-sm text-base-content/60">{portal.url}</div>
										</div>
										{#if selectedPortalId === portal.id}
											<Radio class="h-5 w-5 text-primary" />
										{/if}
									</div>
								</button>
							{/each}
						</div>
					</div>

					<div class="divider">{m.livetv_portalScanModal_orDivider()}</div>
				{/if}

				<!-- Create New Portal -->
				<div class="space-y-3">
					<button
						class="w-full rounded-lg border p-3 text-left transition-colors {creatingPortal
							? 'border-primary bg-primary/5'
							: 'border-base-300 hover:border-primary/50'}"
						onclick={() => {
							creatingPortal = true;
							selectedPortalId = null;
						}}
					>
						<div class="font-medium">{m.livetv_portalScanModal_addNewPortal()}</div>
						<div class="text-sm text-base-content/60">
							{m.livetv_portalScanModal_enterPortalUrl()}
						</div>
					</button>

					{#if creatingPortal}
						<div class="ml-4 space-y-3 border-l-2 border-primary/20 pl-4">
							<div class="form-control">
								<label class="label py-1" for="portalUrl">
									<span class="label-text">{m.livetv_portalScanModal_portalUrlLabel()}</span>
								</label>
								<div class="flex gap-2">
									<input
										id="portalUrl"
										type="url"
										class="input-bordered input flex-1 input-sm"
										bind:value={newPortalUrl}
										placeholder={m.livetv_portalScanModal_portalUrlPlaceholder()}
									/>
									<button
										class="btn btn-ghost btn-sm"
										onclick={detectPortal}
										disabled={detectingPortal || !newPortalUrl.trim()}
									>
										{#if detectingPortal}
											<Loader2 class="h-4 w-4 animate-spin" />
										{:else}
											{m.livetv_portalScanModal_detectButton()}
										{/if}
									</button>
								</div>
							</div>

							<div class="form-control">
								<label class="label py-1" for="portalName">
									<span class="label-text">{m.livetv_portalScanModal_portalNameLabel()}</span>
								</label>
								<input
									id="portalName"
									type="text"
									class="input-bordered input input-sm"
									bind:value={newPortalName}
									placeholder={m.livetv_portalScanModal_portalNamePlaceholder()}
								/>
							</div>
						</div>
					{/if}
				</div>
			{/if}

			{#if portalError}
				<div class="alert text-sm alert-error">
					<span>{portalError}</span>
				</div>
			{/if}
		</div>

		<!-- Portal Step Actions -->
		<div class="modal-action">
			<button class="btn btn-ghost" onclick={onClose}
				>{m.livetv_portalScanModal_cancelButton()}</button
			>
			<button
				class="btn btn-primary"
				disabled={!canProceedToConfig}
				onclick={() => (currentStep = 'config')}
			>
				{m.livetv_portalScanModal_nextButton()}
				<ChevronRight class="h-4 w-4" />
			</button>
		</div>
	{/if}

	<!-- Step 2: Scan Configuration -->
	{#if currentStep === 'config'}
		<div class="space-y-6">
			<!-- Portal Info -->
			<div class="rounded-lg bg-base-200 p-3">
				<div class="text-sm text-base-content/60">
					{m.livetv_portalScanModal_scanningPortalLabel()}
				</div>
				<div class="font-medium">
					{selectedPortal?.name || newPortalName || m.livetv_portalScanModal_newPortal()}
				</div>
				<div class="text-sm text-base-content/60">
					{selectedPortal?.url || newPortalUrl}
				</div>
			</div>

			<!-- Scan Type Selection -->
			<div class="form-control">
				<div class="label py-1">
					<span class="label-text font-medium">{m.livetv_portalScanModal_scanTypeLabel()}</span>
				</div>
				<div class="flex flex-wrap gap-2">
					<button
						class="btn btn-sm {scanType === 'random' ? 'btn-primary' : 'btn-ghost'}"
						onclick={() => (scanType = 'random')}
					>
						{m.livetv_portalScanModal_randomScan()}
					</button>
					<button
						class="btn btn-sm {scanType === 'sequential' ? 'btn-primary' : 'btn-ghost'}"
						onclick={() => (scanType = 'sequential')}
					>
						{m.livetv_portalScanModal_sequentialScan()}
					</button>
					<button
						class="btn btn-sm {scanType === 'import' ? 'btn-primary' : 'btn-ghost'}"
						onclick={() => (scanType = 'import')}
					>
						{m.livetv_portalScanModal_importList()}
					</button>
				</div>
			</div>

			<!-- Random Scan Options -->
			{#if scanType === 'random'}
				<div class="space-y-4">
					<div class="form-control">
						<label class="label py-1" for="macPrefix">
							<span class="label-text">{m.livetv_portalScanModal_macPrefixLabel()}</span>
						</label>
						<select id="macPrefix" class="select-bordered select select-sm" bind:value={macPrefix}>
							{#each macPrefixes as { prefix, name } (prefix)}
								<option value={prefix}>{prefix} - {name}</option>
							{/each}
						</select>
						<div class="label py-1">
							<span class="label-text-alt text-xs">
								{m.livetv_portalScanModal_macPrefixHint()}
							</span>
						</div>
					</div>

					<div class="form-control">
						<label class="label py-1" for="macCount">
							<span class="label-text">{m.livetv_portalScanModal_macCountLabel()}</span>
						</label>
						<input
							id="macCount"
							type="number"
							class="input-bordered input w-32 input-sm"
							bind:value={macCount}
							min="1"
							max="10000"
						/>
						<div class="label py-1">
							<span class="label-text-alt text-xs">{m.livetv_portalScanModal_macCountHint()}</span>
						</div>
					</div>
				</div>
			{/if}

			<!-- Sequential Scan Options -->
			{#if scanType === 'sequential'}
				<div class="space-y-4">
					<div class="form-control">
						<label class="label py-1" for="macStart">
							<span class="label-text">{m.livetv_portalScanModal_startMacLabel()}</span>
						</label>
						<input
							id="macStart"
							type="text"
							class="input-bordered input font-mono input-sm"
							class:input-error={macRangeStart && !isValidMac(macRangeStart)}
							value={macRangeStart}
							oninput={(e) => handleMacInput(e, 'start')}
							placeholder={m.livetv_portalScanModal_startMacPlaceholder()}
							maxlength="17"
						/>
					</div>

					<div class="form-control">
						<label class="label py-1" for="macEnd">
							<span class="label-text">{m.livetv_portalScanModal_endMacLabel()}</span>
						</label>
						<input
							id="macEnd"
							type="text"
							class="input-bordered input font-mono input-sm"
							class:input-error={macRangeEnd && !isValidMac(macRangeEnd)}
							value={macRangeEnd}
							oninput={(e) => handleMacInput(e, 'end')}
							placeholder={m.livetv_portalScanModal_endMacPlaceholder()}
							maxlength="17"
						/>
					</div>

					{#if isValidMac(macRangeStart) && isValidMac(macRangeEnd)}
						{@const startNum = parseInt(macRangeStart.replace(/:/g, ''), 16)}
						{@const endNum = parseInt(macRangeEnd.replace(/:/g, ''), 16)}
						{@const rangeSize = Math.abs(endNum - startNum) + 1}
						<div class="text-sm text-base-content/60">
							{m.livetv_portalScanModal_rangeSize()}
							{rangeSize.toLocaleString(undefined)} MACs
							{#if rangeSize > 1000000}
								<span class="text-warning">{m.livetv_portalScanModal_largeRangeWarning()}</span>
							{/if}
						</div>
					{/if}
				</div>
			{/if}

			<!-- Import Scan Options -->
			{#if scanType === 'import'}
				<div class="form-control">
					<label class="label py-1" for="importMacs">
						<span class="label-text">{m.livetv_portalScanModal_macAddressesLabel()}</span>
					</label>
					<textarea
						id="importMacs"
						class="textarea-bordered textarea h-32 font-mono text-sm"
						bind:value={importedMacs}
						placeholder={m.livetv_portalScanModal_macAddressesPlaceholder()}></textarea>
					<div class="label py-1">
						<span class="label-text-alt text-xs">
							{m.livetv_portalScanModal_macAddressesHint()}
						</span>
					</div>
					{#if importedMacs.trim()}
						{@const count = importedMacs.split(/[\n,;]+/).filter((m) => m.trim()).length}
						<div class="text-sm text-base-content/60">
							{m.livetv_portalScanModal_macCountDetected({ count })}
						</div>
					{/if}
				</div>
			{/if}

			<!-- Rate Limit -->
			<div class="form-control">
				<label class="label py-1" for="rateLimit">
					<span class="label-text">{m.livetv_portalScanModal_delayLabel()}</span>
					<span class="label-text-alt">{rateLimit}ms</span>
				</label>
				<input
					id="rateLimit"
					type="range"
					class="range range-sm"
					bind:value={rateLimit}
					min="100"
					max="5000"
					step="100"
				/>
				<div class="label py-1">
					<span class="label-text-alt text-xs">{m.livetv_portalScanModal_delayHint()}</span>
				</div>
			</div>

			{#if scanError}
				<div class="alert text-sm alert-error">
					<span>{scanError}</span>
				</div>
			{/if}
		</div>

		<!-- Config Step Actions -->
		<div class="modal-action">
			<button class="btn btn-ghost" onclick={() => (currentStep = 'portal')}>
				<ChevronLeft class="h-4 w-4" />
				{m.livetv_portalScanModal_backButton()}
			</button>
			<button class="btn btn-ghost" onclick={onClose}
				>{m.livetv_portalScanModal_cancelButton()}</button
			>
			<button
				class="btn btn-primary"
				disabled={startingScan || !canStartScan()}
				onclick={handleStartScan}
			>
				{#if startingScan}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<Search class="h-4 w-4" />
				{/if}
				{m.livetv_portalScanModal_startScanButton()}
			</button>
		</div>
	{/if}
</ModalWrapper>
