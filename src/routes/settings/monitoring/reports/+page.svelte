<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import {
		AlertTriangle,
		Ban,
		Check,
		ChevronRight,
		Copy,
		Download,
		ExternalLink,
		FileX,
		Loader2,
		RefreshCw,
		Search,
		Settings,
		ShieldX,
		Unlink,
		X
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import MatchFileModal from '#lib/components/library/MatchFileModal.svelte';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import { copyToClipboard } from '#lib/utils/clipboard.js';

	let { data } = $props();

	const TABS = [
		{
			id: 'unmatched-imports',
			label: m.reports_tab_unmatchedImports(),
			countKey: 'unmatchedImports' as const,
			icon: Unlink
		},
		{
			id: 'rejected-releases',
			label: m.reports_tab_rejectedReleases(),
			countKey: 'rejectedReleases' as const,
			icon: Ban
		},
		{
			id: 'import-failures',
			label: m.reports_tab_importFailures(),
			countKey: 'importFailures' as const,
			icon: Download
		},
		{
			id: 'renaming-failures',
			label: m.reports_tab_renamingFailures(),
			countKey: 'renamingFailures' as const,
			icon: FileX
		}
	] as const;

	type TabId = (typeof TABS)[number]['id'];
	type AnyRecord = { id: string; [key: string]: unknown };

	const activeTab = $derived((page.url.searchParams.get('tab') as TabId) || TABS[0].id);

	let records = $state<AnyRecord[]>([]);
	let loading = $state(false);
	let total = $state(0);
	let currentPage = $state(1);
	const PAGE_SIZE = 25;
	const totalPages = $derived(Math.ceil(total / PAGE_SIZE));
	let expandedId = $state<string | null>(null);
	const _seedCounts = untrack(() => ({ ...data.counts }));
	let counts = $state(_seedCounts);

	// Unmatched-imports specific
	type UnmatchedStats = {
		total: number;
		newIn24h: number;
		noMatch: number;
		parseFailures: number;
		belowThreshold: number;
	};
	let unmatchedStats = $state<UnmatchedStats | null>(null);

	// Rejected-releases specific
	type RejectedStats = {
		total: number;
		newIn24h: number;
		formatMismatch: number;
		profileMismatch: number;
		delayPending: number;
	};
	type RejectionCheck = { type: string; rule: string; passed: boolean; detail?: string };
	let rejectedStats = $state<RejectedStats | null>(null);

	// Import-failures specific
	type ImportStats = {
		total: number;
		newIn24h: number;
		pathResolution: number;
		diskSpace: number;
		dangerousFiles: number;
		transfer: number;
		maxRetries: number;
	};
	let importStats = $state<ImportStats | null>(null);

	type RenamingStats = {
		total: number;
		newIn24h: number;
		collisions: number;
		permissionIo: number;
	};
	let renamingStats = $state<RenamingStats | null>(null);
	let renamingFileTypeFilter = $state('');

	let searchQuery = $state('');
	let reasonFilter = $state('');
	let dateFilter = $state('');
	let mediaTypeFilter = $state('');
	let selectedIds = $state<Set<string>>(new Set());
	let showExportMenu = $state(false);
	let matchModalRecord = $state<AnyRecord | null>(null);
	let scrollY = $state(0);
	let tabBarEl = $state<HTMLDivElement | null>(null);
	let searchTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		if (!tabBarEl) return;
		// scroll active tab into view whenever the active tab changes (including on load)
		void activeTab;
		const active = tabBarEl.querySelector<HTMLElement>('[class*="border-primary"]');
		active?.scrollIntoView({ block: 'nearest', inline: 'center' });
	});

	function switchTab(tabId: TabId) {
		records = [];
		currentPage = 1;
		expandedId = null;
		selectedIds = new Set();
		searchQuery = '';
		reasonFilter = '';
		dateFilter = '';
		mediaTypeFilter = '';
		renamingFileTypeFilter = '';
		goto(`?tab=${tabId}`, { replace: true });
	}

	function applyStatCard(card: 'all' | '24h' | 'no_match' | 'parse_failed' | 'unresolved') {
		if (card === 'all') {
			reasonFilter = '';
			dateFilter = '';
		} else if (card === '24h') {
			dateFilter = '24h';
			reasonFilter = '';
		} else if (card === 'no_match') {
			reasonFilter = 'no_match';
			dateFilter = '';
		} else if (card === 'parse_failed') {
			reasonFilter = 'parse_failed';
			dateFilter = '';
		} else if (card === 'unresolved') {
			reasonFilter = 'unresolved';
			dateFilter = '';
		}
		loadRecords('unmatched-imports', 1);
	}

	function unmatchedUrlParams() {
		let extra = '';
		if (searchQuery.trim()) extra += `&search=${encodeURIComponent(searchQuery.trim())}`;
		if (mediaTypeFilter) extra += `&mediaType=${encodeURIComponent(mediaTypeFilter)}`;
		if (dateFilter) extra += `&since=${encodeURIComponent(dateFilter)}`;
		if (reasonFilter === 'unresolved') {
			extra += `&reasonGroup=below_threshold`;
		} else if (reasonFilter) {
			extra += `&reason=${encodeURIComponent(reasonFilter)}`;
		}
		return extra;
	}

	const activeRejectedStatCard = $derived(
		dateFilter === '24h' && !reasonFilter
			? '24h'
			: reasonFilter === 'required_format_mismatch'
				? 'format'
				: reasonFilter === 'quality_profile_mismatch'
					? 'profile'
					: reasonFilter === 'delay_profile_pending'
						? 'delay'
						: !reasonFilter && !dateFilter
							? 'all'
							: null
	);

	// Derive which stat card is visually active from toolbar state
	const activeStatCard = $derived(
		dateFilter === '24h' && !reasonFilter
			? '24h'
			: reasonFilter === 'no_match'
				? 'no_match'
				: reasonFilter === 'parse_failed'
					? 'parse_failed'
					: reasonFilter === 'unresolved'
						? 'unresolved'
						: !reasonFilter && !dateFilter
							? 'all'
							: null
	);

	async function loadRecords(tab: TabId, pg: number = 1) {
		loading = true;
		try {
			let url = `/api/reports/${tab}?page=${pg}&limit=${PAGE_SIZE}&order=desc`;
			if (tab === 'unmatched-imports') url += unmatchedUrlParams();
			else if (tab === 'rejected-releases') url += rejectedUrlParams();
			else if (tab === 'import-failures') url += importUrlParams();
			else if (tab === 'renaming-failures') url += renamingUrlParams();
			const res = await fetch(url);
			const result = await res.json();
			if (result.success) {
				records = result.data.records;
				total = result.data.pagination.total;
				currentPage = pg;
			} else {
				toasts.error(result.error || 'Failed to load records');
			}
		} catch {
			toasts.error('Failed to load records');
		} finally {
			loading = false;
		}
	}

	async function appendRecords(tab: TabId, pg: number) {
		try {
			let url = `/api/reports/${tab}?page=${pg}&limit=${PAGE_SIZE}&order=desc`;
			if (tab === 'unmatched-imports') url += unmatchedUrlParams();
			else if (tab === 'rejected-releases') url += rejectedUrlParams();
			else if (tab === 'import-failures') url += importUrlParams();
			else if (tab === 'renaming-failures') url += renamingUrlParams();
			const res = await fetch(url);
			const result = await res.json();
			if (result.success) {
				records = [...records, ...result.data.records];
				currentPage = pg;
			}
		} catch {
			/* silent */
		}
	}

	async function loadUnmatchedStats() {
		try {
			const res = await fetch('/api/reports/unmatched-stats');
			const result = await res.json();
			if (result.success) unmatchedStats = result.data;
		} catch {
			/* silent */
		}
	}

	async function loadRejectedStats() {
		try {
			const res = await fetch('/api/reports/rejected-stats');
			const result = await res.json();
			if (result.success) rejectedStats = result.data;
		} catch {
			/* silent */
		}
	}

	async function loadImportStats() {
		try {
			const res = await fetch('/api/reports/import-failures-stats');
			const result = await res.json();
			if (result.success) importStats = result.data;
		} catch {
			/* silent */
		}
	}

	async function loadRenamingStats() {
		try {
			const res = await fetch('/api/reports/renaming-failures-stats');
			const result = await res.json();
			if (result.success) renamingStats = result.data;
		} catch {
			/* silent */
		}
	}

	function renamingUrlParams() {
		let extra = '';
		if (searchQuery.trim()) extra += `&search=${encodeURIComponent(searchQuery.trim())}`;
		if (dateFilter) extra += `&since=${encodeURIComponent(dateFilter)}`;
		if (reasonFilter) extra += `&reason=${encodeURIComponent(reasonFilter)}`;
		if (renamingFileTypeFilter) extra += `&fileType=${encodeURIComponent(renamingFileTypeFilter)}`;
		return extra;
	}

	const activeRenamingStatCard = $derived(
		dateFilter === '24h' && !reasonFilter
			? '24h'
			: reasonFilter === 'collision'
				? 'collision'
				: reasonFilter === 'permission_denied' ||
					  reasonFilter === 'io_error' ||
					  reasonFilter === 'disk_full'
					? 'permissionIo'
					: !reasonFilter && !dateFilter
						? 'all'
						: null
	);

	function applyRenamingStatCard(card: 'all' | '24h' | 'collision' | 'permissionIo') {
		if (card === 'all') {
			reasonFilter = '';
			dateFilter = '';
		} else if (card === '24h') {
			dateFilter = '24h';
			reasonFilter = '';
		} else if (card === 'collision') {
			reasonFilter = 'collision';
			dateFilter = '';
		} else if (card === 'permissionIo') {
			reasonFilter = 'permission_denied';
			dateFilter = '';
		}
		loadRecords('renaming-failures', 1);
	}

	function renamingReasonBadgeClass(reason: string) {
		switch (reason) {
			case 'collision':
				return 'badge-error';
			case 'permission_denied':
			case 'disk_full':
				return 'badge-warning';
			case 'source_not_found':
				return 'badge-ghost';
			case 'path_too_long':
			case 'invalid_chars':
				return 'badge-info';
			default:
				return 'badge-neutral';
		}
	}

	function renamingReasonLabel(reason: string) {
		switch (reason) {
			case 'collision':
				return m.reports_renaming_reason_collision();
			case 'io_error':
				return m.reports_renaming_reason_ioError();
			case 'permission_denied':
				return m.reports_renaming_reason_permissionDenied();
			case 'source_not_found':
				return m.reports_renaming_reason_sourceNotFound();
			case 'path_too_long':
				return m.reports_renaming_reason_pathTooLong();
			case 'invalid_chars':
				return m.reports_renaming_reason_invalidChars();
			case 'disk_full':
				return m.reports_renaming_reason_diskFull();
			case 'preview_error':
				return m.reports_renaming_reason_previewError();
			default:
				return reason;
		}
	}

	function renamingReasonShortLabel(reason: string) {
		switch (reason) {
			case 'collision':
				return 'Collision';
			case 'io_error':
				return 'I/O';
			case 'permission_denied':
				return 'Permission';
			case 'source_not_found':
				return 'Not found';
			case 'path_too_long':
				return 'Too long';
			case 'invalid_chars':
				return 'Inv. chars';
			case 'disk_full':
				return 'No space';
			case 'preview_error':
				return 'Preview';
			default:
				return reason;
		}
	}

	function fileTypeLabel(t: string) {
		return t === 'episode' ? m.reports_type_tv() : m.reports_type_movie();
	}
	function mediaTypeLabel(t: string | null | undefined) {
		return t === 'tv' ? m.reports_type_tv() : t === 'movie' ? m.reports_type_movie() : (t ?? '—');
	}

	async function copyRenamingBundle(record: Record<string, unknown>) {
		const bundle = {
			sourcePath: record.sourcePath,
			intendedPath: record.intendedPath,
			fileType: record.fileType,
			reason: record.reason,
			reasonDetail: record.reasonDetail,
			namingTemplate: record.namingTemplate,
			correlationId: record.correlationId,
			failedAt: record.failedAt
		};
		const ok = await copyToClipboard(JSON.stringify(bundle, null, 2));
		if (ok) toasts.success(m.reports_renaming_bundleCopied());
		else toasts.error('Failed to copy');
	}

	function rejectedUrlParams() {
		let extra = '';
		if (searchQuery.trim()) extra += `&search=${encodeURIComponent(searchQuery.trim())}`;
		if (mediaTypeFilter) extra += `&mediaType=${encodeURIComponent(mediaTypeFilter)}`;
		if (dateFilter) extra += `&since=${encodeURIComponent(dateFilter)}`;
		if (reasonFilter) extra += `&reason=${encodeURIComponent(reasonFilter)}`;
		return extra;
	}

	function importUrlParams() {
		let extra = '';
		if (searchQuery.trim()) extra += `&search=${encodeURIComponent(searchQuery.trim())}`;
		if (dateFilter) extra += `&since=${encodeURIComponent(dateFilter)}`;
		if (reasonFilter) extra += `&stage=${encodeURIComponent(reasonFilter)}`;
		return extra;
	}

	const activeImportStatCard = $derived(
		dateFilter === '24h' && !reasonFilter
			? '24h'
			: reasonFilter === 'path_resolution'
				? 'path_resolution'
				: reasonFilter === 'disk_space'
					? 'disk_space'
					: reasonFilter === 'dangerous_files'
						? 'dangerous_files'
						: reasonFilter === 'transfer'
							? 'transfer'
							: reasonFilter === 'max_retries'
								? 'max_retries'
								: !reasonFilter && !dateFilter
									? 'all'
									: null
	);

	function applyImportStatCard(
		card:
			| 'all'
			| '24h'
			| 'path_resolution'
			| 'disk_space'
			| 'dangerous_files'
			| 'transfer'
			| 'max_retries'
	) {
		if (card === 'all') {
			reasonFilter = '';
			dateFilter = '';
		} else if (card === '24h') {
			dateFilter = '24h';
			reasonFilter = '';
		} else {
			reasonFilter = card;
			dateFilter = '';
		}
		loadRecords('import-failures', 1);
	}

	function applyRejectedStatCard(card: 'all' | '24h' | 'format' | 'profile' | 'delay') {
		if (card === 'all') {
			reasonFilter = '';
			dateFilter = '';
		} else if (card === '24h') {
			dateFilter = '24h';
			reasonFilter = '';
		} else if (card === 'format') {
			reasonFilter = 'required_format_mismatch';
			dateFilter = '';
		} else if (card === 'profile') {
			reasonFilter = 'quality_profile_mismatch';
			dateFilter = '';
		} else if (card === 'delay') {
			reasonFilter = 'delay_profile_pending';
			dateFilter = '';
		}
		loadRecords('rejected-releases', 1);
	}

	function rejectedReasonBadgeClass(reason: string | null | undefined) {
		switch (reason) {
			case 'required_format_mismatch':
				return 'badge-error';
			case 'quality_profile_mismatch':
				return 'badge-warning';
			case 'delay_profile_pending':
				return 'badge-info';
			default:
				return 'badge-ghost';
		}
	}

	function rejectedReasonLabel(reason: string | null | undefined) {
		switch (reason) {
			case 'required_format_mismatch':
				return m.reports_rejected_reason_required_format_mismatch();
			case 'quality_profile_mismatch':
				return m.reports_rejected_reason_quality_profile_mismatch();
			case 'delay_profile_pending':
				return m.reports_rejected_reason_delay_profile_pending();
			default:
				return reason ?? m.reports_rejected_reason_other();
		}
	}

	function rejectedReasonShortLabel(reason: string | null | undefined) {
		switch (reason) {
			case 'required_format_mismatch':
				return 'Format';
			case 'quality_profile_mismatch':
				return 'Profile';
			case 'delay_profile_pending':
				return 'Delay';
			default:
				return 'Other';
		}
	}

	async function overrideRejectedRelease(record: AnyRecord) {
		try {
			const res = await fetch(`/api/reports/rejected-releases/${record.id}/override`, {
				method: 'POST'
			});
			const result = await res.json();
			if (result.success) {
				records = records.map((r) => (r.id === record.id ? { ...r, status: 'overridden' } : r));
				toasts.success(m.reports_rejected_overrideSuccess());
				refreshCounts();
				loadRejectedStats();
			} else {
				toasts.error(result.error ?? m.reports_rejected_overrideFail());
			}
		} catch {
			toasts.error(m.reports_rejected_overrideFail());
		}
	}

	async function copyRejectedBundle(record: AnyRecord) {
		const bundle = {
			releaseTitle: record.releaseTitle,
			mediaTitle: record.mediaTitle,
			mediaType: record.mediaType,
			indexerName: record.indexerName,
			protocol: record.protocol,
			primaryReason: record.primaryReason,
			ruleFired: record.ruleFired,
			qualityProfileName: record.qualityProfileName,
			releaseSize: record.releaseSize,
			rejectionChecks: record.rejectionReasons,
			correlationId: record.correlationId,
			rejectedAt: record.rejectedAt
		};
		const ok = await copyToClipboard(JSON.stringify(bundle, null, 2));
		if (ok) {
			toasts.success(m.reports_rejected_bundleCopied());
		} else {
			toasts.error('Failed to copy');
		}
	}

	async function refreshCounts() {
		try {
			const res = await fetch('/api/reports/summary');
			const result = await res.json();
			if (result.success) counts = result.data;
		} catch {
			/* silent */
		}
	}

	// Auto-refresh for import-failures
	let lastRefreshed = $state<Date | null>(null);
	$effect(() => {
		if (activeTab !== 'import-failures') return;
		const interval = setInterval(() => {
			loadRecords('import-failures', currentPage);
			loadImportStats();
			lastRefreshed = new Date();
		}, 60_000);
		return () => clearInterval(interval);
	});

	async function bulkResolve() {
		const tab = activeTab;
		if (tab === 'unmatched-imports' || selectedIds.size === 0) return;
		const ids = [...selectedIds];
		try {
			const res = await fetch(`/api/reports/${tab}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids, status: 'resolved' })
			});
			const result = await res.json();
			if (result.success) {
				records = records.filter((r) => !selectedIds.has(r.id));
				total = Math.max(0, total - ids.length);
				selectedIds = new Set();
				toasts.success(`${ids.length} records resolved`);
				refreshCounts();
				if (tab === 'rejected-releases') loadRejectedStats();
				else if (tab === 'import-failures') loadImportStats();
				else if (tab === 'renaming-failures') loadRenamingStats();
			} else {
				toasts.error(result.error || 'Failed to resolve');
			}
		} catch {
			toasts.error('Failed to resolve');
		}
	}

	let confirmResolveAllOpen = $state(false);
	let resolvingAll = $state(false);

	function resolveAll() {
		if (activeTab === 'unmatched-imports' || total === 0) return;
		confirmResolveAllOpen = true;
	}

	async function confirmResolveAll() {
		const tab = activeTab;
		resolvingAll = true;
		try {
			const res = await fetch(`/api/reports/${tab}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ resolveAll: true, status: 'resolved' })
			});
			const result = await res.json();
			if (result.success) {
				records = [];
				total = 0;
				selectedIds = new Set();
				toasts.success(`${result.data.updated} records resolved`);
				refreshCounts();
				if (tab === 'rejected-releases') loadRejectedStats();
				else if (tab === 'import-failures') loadImportStats();
				else if (tab === 'renaming-failures') loadRenamingStats();
			} else {
				toasts.error(result.error || 'Failed to resolve all');
			}
		} catch {
			toasts.error('Failed to resolve all');
		} finally {
			resolvingAll = false;
			confirmResolveAllOpen = false;
		}
	}

	async function resolveRecord(id: string) {
		const tab = activeTab;
		if (tab === 'unmatched-imports') return;
		try {
			const res = await fetch(`/api/reports/${tab}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids: [id], status: 'resolved' })
			});
			const result = await res.json();
			if (result.success) {
				records = records.filter((r) => r.id !== id);
				total = Math.max(0, total - 1);
				toasts.success('Record resolved');
				refreshCounts();
				if (tab === 'rejected-releases') loadRejectedStats();
				else if (tab === 'import-failures') loadImportStats();
				else if (tab === 'renaming-failures') loadRenamingStats();
			} else {
				toasts.error(result.error || 'Failed to resolve');
			}
		} catch {
			toasts.error('Failed to resolve');
		}
	}

	async function forceMatch(record: AnyRecord) {
		type Candidate = { tmdbId: number; title: string; year?: number; confidence: number };
		const top = (record.suggestedMatches as Candidate[] | null)?.[0];
		if (!top?.tmdbId) return;
		try {
			const res = await fetch('/api/library/unmatched/match', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					fileIds: [record.id],
					tmdbId: top.tmdbId,
					mediaType: record.mediaType ?? 'movie'
				})
			});
			const result = await res.json();
			if (result.success) {
				records = records.filter((r) => r.id !== record.id);
				total = Math.max(0, total - 1);
				expandedId = null;
				toasts.success(m.reports_unmatched_forceMatchSuccess());
				refreshCounts();
				loadUnmatchedStats();
			} else {
				toasts.error(m.reports_unmatched_forceMatchFail());
			}
		} catch {
			toasts.error(m.reports_unmatched_forceMatchFail());
		}
	}

	async function copyDiagnosticBundle(record: AnyRecord) {
		const bundle = {
			file: record.path,
			mediaType: record.mediaType,
			parsedTitle: record.parsedTitle,
			parsedYear: record.parsedYear,
			reason: record.reason,
			correlationId: record.correlationId,
			ambiguityMargin: record.ambiguityMargin,
			candidates: record.suggestedMatches,
			discoveredAt: record.discoveredAt
		};
		const text = JSON.stringify(bundle, null, 2);
		const ok = await copyToClipboard(text);
		if (ok) {
			toasts.success(m.reports_unmatched_bundleCopied());
		} else {
			toasts.error('Failed to copy');
		}
	}
	async function copyImportBundle(record: Record<string, unknown>) {
		const bundle = {
			releaseTitle: record.releaseTitle,
			sourcePath: record.sourcePath,
			destinationPath: record.destinationPath,
			failureStage: record.failureStage,
			reason: record.reason,
			reasonDetail: record.reasonDetail,
			dangerousFiles: record.dangerousFiles,
			attemptCount: record.attemptCount,
			downloadClient: record.downloadClientName ?? record.downloadClientId,
			correlationId: record.correlationId,
			failedAt: record.failedAt
		};
		const ok = await copyToClipboard(JSON.stringify(bundle, null, 2));
		if (ok) toasts.success(m.reports_import_bundleCopied());
		else toasts.error('Failed to copy');
	}

	function exportRecords(format: 'csv' | 'json') {
		showExportMenu = false;
		const blob =
			format === 'json'
				? new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' })
				: new Blob(
						[
							'id,path,mediaType,parsedTitle,parsedYear,reason,discoveredAt\n' +
								records
									.map((r) =>
										[
											r.id,
											r.path,
											r.mediaType,
											r.parsedTitle,
											r.parsedYear,
											r.reason,
											r.discoveredAt
										]
											.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
											.join(',')
									)
									.join('\n')
						],
						{ type: 'text/csv' }
					);
		const url = URL.createObjectURL(blob);
		Object.assign(document.createElement('a'), {
			href: url,
			download: `unmatched-imports.${format}`
		}).click();
		URL.revokeObjectURL(url);
	}

	async function copySelectedAsJson() {
		const sel = records.filter((r) => selectedIds.has(r.id));
		const ok = await copyToClipboard(JSON.stringify(sel, null, 2));
		if (ok) toasts.success(`${sel.length} items copied`);
		else toasts.error('Failed to copy');
	}

	function onSearchInput() {
		if (searchTimer) clearTimeout(searchTimer);
		searchTimer = setTimeout(() => loadRecords(activeTab, 1), 350);
	}

	$effect(() => {
		const tab = activeTab;
		loadRecords(tab, 1);
		if (tab === 'unmatched-imports') loadUnmatchedStats();
		else if (tab === 'rejected-releases') loadRejectedStats();
		else if (tab === 'import-failures') loadImportStats();
		else if (tab === 'renaming-failures') loadRenamingStats();
	});

	// Formatters

	function timeAgo(iso: string | null | undefined): string {
		if (!iso) return '-';
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return `${Math.floor(diff / 86_400_000)}d ago`;
	}

	function formatDate(iso: string | null | undefined) {
		return iso ? new Date(iso).toLocaleString() : '-';
	}

	function formatBytes(bytes: number | null | undefined) {
		if (!bytes) return null;
		const gb = bytes / 1_073_741_824;
		return gb >= 0.1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1_048_576)} MB`;
	}

	function pct(n: number) {
		return `${Math.round(n * 100)}%`;
	}

	function reasonBadgeClass(reason: string | null | undefined) {
		switch (reason) {
			case 'no_match':
			case 'parse_failed':
				return 'badge-error';
			case 'multiple_matches':
			case 'ambiguous':
				return 'badge-warning';
			default:
				return 'badge-ghost';
		}
	}

	function reasonLabel(reason: string | null | undefined) {
		const map: Record<string, string> = {
			no_match: m.reports_reason_no_match(),
			low_confidence: m.reports_reason_low_confidence(),
			multiple_matches: m.reports_reason_multiple_matches(),
			ambiguous: m.reports_reason_ambiguous(),
			parse_failed: m.reports_reason_parse_failed(),
			root_folder_conflict: m.reports_reason_root_folder_conflict(),
			collision: m.reports_reason_collision()
		};
		return reason ? (map[reason] ?? reason) : '-';
	}

	function stageLabel(stage: string | null | undefined) {
		const map: Record<string, string> = {
			path_resolution: m.reports_stage_path_resolution(),
			dangerous_files: m.reports_stage_dangerous_files(),
			disk_space: m.reports_stage_disk_space(),
			root_folder: m.reports_stage_root_folder(),
			library_entity: m.reports_stage_library_entity(),
			transfer: m.reports_stage_transfer(),
			max_retries: m.reports_stage_max_retries()
		};
		return stage ? (map[stage] ?? stage) : '-';
	}

	function statusBadgeClass(s: string | null | undefined) {
		switch (s) {
			case 'rejected':
			case 'failed':
			case 'unresolved':
				return 'badge-error';
			case 'resolved':
				return 'badge-success';
			case 'overridden':
			case 'ignored':
				return 'badge-ghost';
			case 'retrying':
				return 'badge-warning';
			default:
				return 'badge-ghost';
		}
	}

	function statusLabel(s: string | null | undefined) {
		const map: Record<string, string> = {
			rejected: m.reports_status_rejected(),
			overridden: m.reports_status_overridden(),
			failed: m.reports_status_failed(),
			resolved: m.reports_status_resolved(),
			retrying: m.reports_status_retrying(),
			unresolved: m.reports_status_unresolved(),
			ignored: m.reports_status_ignored()
		};
		return s ? (map[s] ?? s) : '-';
	}

	function barClass(c: number) {
		return c >= 0.75 ? 'bg-primary' : c >= 0.5 ? 'bg-warning' : 'bg-error';
	}

	function parsedTokens(r: AnyRecord) {
		const parts: string[] = [];
		if (r.parsedTitle) parts.push(`title="${r.parsedTitle}"`);
		if (r.parsedYear) parts.push(`year=${r.parsedYear}`);
		if (r.parsedSeason != null) parts.push(`season=${r.parsedSeason}`);
		if (r.parsedEpisode != null) parts.push(`episode=${r.parsedEpisode}`);
		return parts.length ? parts.join(', ') : 'none';
	}

	function shortCorr(id: string | null | undefined) {
		return id ? id.slice(0, 8) : '';
	}

	const REASON_OPTIONS = [
		{ value: '', label: m.reports_filter_allReasons() },
		{ value: 'no_match', label: m.reports_reason_no_match() },
		{ value: 'unresolved', label: m.reports_unmatched_stat_unresolved() },
		{ value: 'low_confidence', label: m.reports_reason_low_confidence() },
		{ value: 'multiple_matches', label: m.reports_reason_multiple_matches() },
		{ value: 'ambiguous', label: m.reports_reason_ambiguous() },
		{ value: 'parse_failed', label: m.reports_reason_parse_failed() }
	];

	const DATE_OPTIONS = [
		{ value: '', label: m.reports_filter_allTime() },
		{ value: '24h', label: m.reports_filter_last24h() },
		{ value: '7d', label: m.reports_filter_last7d() },
		{ value: '30d', label: m.reports_filter_last30d() }
	];
</script>

<svelte:head>
	<title>{m.reports_heading()}</title>
</svelte:head>

<!-- close export menu on outside click -->
<svelte:window
	onclick={() => {
		if (showExportMenu) showExportMenu = false;
	}}
	onscroll={() => {
		scrollY = window.scrollY;
	}}
/>

<!-- Scroll to top -->
{#if scrollY > 300}
	<button
		class="btn fixed right-6 bottom-6 z-50 gap-1.5 opacity-80 shadow-lg transition-opacity btn-neutral btn-sm hover:opacity-100"
		onclick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
		aria-label="Scroll to top"
	>
		<svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
			><path d="M8 12V4M4 8l4-4 4 4" /></svg
		>
	</button>
{/if}

<div class="space-y-5">
	<!-- Header -->
	<div>
		<h1 class="text-2xl font-bold">{m.reports_heading()}</h1>
		<p class="mt-1 text-sm text-base-content/70">{m.reports_description()}</p>
	</div>

	<!-- Tab bar -->
	<div class="flex scrollbar-none overflow-x-auto border-b border-base-200" bind:this={tabBarEl}>
		{#each TABS as tab (tab.id)}
			{@const isActive = activeTab === tab.id}
			{@const tabCount = counts[tab.countKey]}
			<button
				class="flex shrink-0 cursor-pointer items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors
					{isActive
					? 'border-primary text-primary'
					: 'border-transparent text-base-content/60 hover:text-base-content'}"
				onclick={() => switchTab(tab.id)}
			>
				<tab.icon class="h-4 w-4" />
				{tab.label}
				{#if tabCount > 0}
					<span class="badge badge-sm {isActive ? 'badge-primary' : 'badge-ghost'}">{tabCount}</span
					>
				{/if}
			</button>
		{/each}
	</div>

	<!-- UNMATCHED IMPORTS SubTab  -->
	{#if activeTab === 'unmatched-imports'}
		<!-- Stat cards -->
		{#if unmatchedStats}
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
				<!-- Total (shows all) -->
				<button
					class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all
						{activeStatCard === 'all'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyStatCard('all')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_unmatched_stat_total()}
					</p>
					<p class="text-3xl font-bold text-error">{unmatchedStats.total}</p>
				</button>
				<!-- New in 24h -->
				<button
					class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all
						{activeStatCard === '24h'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyStatCard('24h')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_unmatched_stat_newIn24h()}
					</p>
					<p
						class="text-3xl font-bold {unmatchedStats.newIn24h > 0
							? 'text-warning'
							: 'text-success'}"
					>
						{unmatchedStats.newIn24h}
					</p>
				</button>
				<!-- No title match -->
				<button
					class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all
						{activeStatCard === 'no_match'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyStatCard('no_match')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_unmatched_stat_noMatch()}
					</p>
					<p class="text-3xl font-bold">{unmatchedStats.noMatch}</p>
				</button>
				<!-- Parse failures -->
				<button
					class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all
						{activeStatCard === 'parse_failed'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyStatCard('parse_failed')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_unmatched_stat_parseFailures()}
					</p>
					<p class="text-3xl font-bold {unmatchedStats.parseFailures > 0 ? 'text-error' : ''}">
						{unmatchedStats.parseFailures}
					</p>
				</button>
				<!-- Unresolved (multiple matches, ambiguous, low confidence) -->
				<button
					class="col-span-2 flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all sm:col-span-1
						{activeStatCard === 'unresolved'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyStatCard('unresolved')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_unmatched_stat_unresolved()}
					</p>
					<p class="text-3xl font-bold">{unmatchedStats.belowThreshold}</p>
					<p class="text-[10px] leading-tight text-base-content/40">
						{m.reports_unmatched_stat_unresolved_sub()}
					</p>
				</button>
			</div>
		{/if}

		<!-- Toolbar -->
		<div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
			<!-- Row 1: search (full width on mobile) -->
			<div class="group relative w-full sm:w-64">
				<div class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2">
					<Search
						class="h-4 w-4 text-base-content/40 transition-colors group-focus-within:text-primary"
					/>
				</div>
				<input
					type="text"
					class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
					placeholder={m.reports_search_fileOrTitle()}
					bind:value={searchQuery}
					oninput={onSearchInput}
				/>
				{#if searchQuery}
					<button
						class="absolute top-1/2 right-3 -translate-y-1/2 text-base-content/40 hover:text-base-content"
						onclick={() => {
							searchQuery = '';
							loadRecords(activeTab, 1);
						}}
					>
						<X class="h-3.5 w-3.5" />
					</button>
				{/if}
			</div>

			<!-- Row 2 on mobile: pills + selects in one wrapping row -->
			<div class="flex flex-wrap items-center gap-2">
				<!-- Media type pills -->
				<div class="flex items-center gap-1">
					{#each [{ value: '', label: m.reports_filter_all() }, { value: 'movie', label: m.reports_type_movie() }, { value: 'tv', label: m.reports_type_tv() }] as opt (opt)}
						<button
							class="btn font-medium btn-sm {mediaTypeFilter === opt.value
								? 'btn-primary'
								: 'btn-ghost'}"
							onclick={() => {
								mediaTypeFilter = opt.value;
								loadRecords(activeTab, 1);
							}}>{opt.label}</button
						>
					{/each}
				</div>

				<span class="h-4 w-px bg-base-content/15"></span>

				<select
					class="select w-36 border-base-content/20 bg-base-200 transition-all select-sm hover:bg-base-200 focus:border-primary/50 focus:outline-none"
					bind:value={reasonFilter}
					onchange={() => loadRecords(activeTab, 1)}
				>
					{#each REASON_OPTIONS as opt (opt)}<option value={opt.value}>{opt.label}</option>{/each}
				</select>
				<select
					class="select w-32 border-base-content/20 bg-base-200 transition-all select-sm hover:bg-base-200 focus:border-primary/50 focus:outline-none"
					bind:value={dateFilter}
					onchange={() => loadRecords(activeTab, 1)}
				>
					{#each DATE_OPTIONS as opt (opt)}<option value={opt.value}>{opt.label}</option>{/each}
				</select>
			</div>

			<div class="flex items-center justify-between gap-2 sm:ml-auto sm:justify-end">
				<span class="text-xs text-base-content/40 tabular-nums"
					>{m.reports_showing({ shown: records.length, total })}</span
				>
				{#if selectedIds.size > 0}
					<button class="btn gap-1.5 btn-outline btn-sm" onclick={copySelectedAsJson}>
						<Copy class="h-3.5 w-3.5" />
						{m.reports_copySelected()} ({selectedIds.size})
					</button>
				{/if}
				<div class="relative">
					<button
						class="btn gap-1 btn-neutral btn-sm"
						disabled={records.length === 0}
						onclick={(e) => {
							e.stopPropagation();
							showExportMenu = !showExportMenu;
						}}
					>
						{m.reports_export()}
						<svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor"
							><path d="M4 6l4 4 4-4" /></svg
						>
					</button>
					{#if showExportMenu}
						<div
							class="absolute top-full right-0 z-20 mt-1 w-40 rounded-lg border border-base-300 bg-base-100 shadow-xl"
						>
							<button
								class="block w-full cursor-pointer rounded-t-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-base-200"
								onclick={() => exportRecords('csv')}>{m.reports_exportCsv()}</button
							>
							<button
								class="block w-full cursor-pointer rounded-b-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-base-200"
								onclick={() => exportRecords('json')}>{m.reports_exportJson()}</button
							>
						</div>
					{/if}
				</div>
			</div>
		</div>

		<!-- Table -->
		{#if loading}
			<div class="flex items-center justify-center py-16">
				<Loader2 class="h-5 w-5 animate-spin text-base-content/40" />
				<span class="ml-2 text-sm text-base-content/60">{m.reports_loading()}</span>
			</div>
		{:else if records.length === 0}
			<div class="flex flex-col items-center justify-center py-20 text-center">
				<Unlink class="mb-3 h-12 w-12 text-base-content/15" />
				<p class="font-medium text-base-content/60">{m.reports_empty()}</p>
				<p class="mt-1 text-sm text-base-content/40">{m.reports_emptyDescription()}</p>
			</div>
		{:else}
			<div class="overflow-x-auto rounded-lg border border-base-content/12 bg-base-100 shadow-sm">
				<table class="table w-full table-sm">
					<thead>
						<tr
							class="border-b border-base-content/10 bg-base-200 text-[11px] font-semibold tracking-widest text-base-content/50 uppercase"
						>
							<th class="w-8 pr-0">
								<input
									type="checkbox"
									class="checkbox checkbox-xs checkbox-primary"
									checked={selectedIds.size === records.length && records.length > 0}
									onchange={(e) => {
										selectedIds = (e.target as HTMLInputElement).checked
											? new Set(records.map((r) => r.id))
											: new Set();
									}}
								/>
							</th>
							<th>{m.reports_col_file()}</th>
							<th>{m.reports_col_reason()}</th>
							<th class="hidden sm:table-cell">{m.reports_col_topCandidate()}</th>
							<th class="hidden text-right sm:table-cell">{m.reports_col_score()}</th>
							<th class="hidden sm:table-cell">{m.reports_col_detected()}</th>
							<th class="hidden w-6 sm:table-cell"></th>
						</tr>
					</thead>
					<tbody class="divide-y divide-base-content/8">
						{#each records as record (record.id)}
							{@const expanded = expandedId === record.id}
							{@const candidates = record.suggestedMatches as Array<{
								tmdbId: number;
								title: string;
								year?: number;
								confidence: number;
							}> | null}
							{@const top = candidates?.[0]}
							{@const isSelected = selectedIds.has(record.id)}
							<tr
								class="cursor-pointer transition-colors {isSelected
									? 'bg-primary/5'
									: 'hover:bg-base-200/50'}"
								onclick={() => (expandedId = expanded ? null : record.id)}
							>
								<td class="pr-0" onclick={(e) => e.stopPropagation()}>
									<input
										type="checkbox"
										class="checkbox checkbox-xs checkbox-primary"
										checked={isSelected}
										onchange={() => {
											const next = new Set(selectedIds);
											if (isSelected) {
												next.delete(record.id);
											} else {
												next.add(record.id);
											}
											selectedIds = next;
										}}
									/>
								</td>
								<td class="max-w-[42vw] sm:max-w-xs">
									<div class="flex items-start gap-1.5">
										<ChevronRight
											class="mt-0.5 h-3.5 w-3.5 shrink-0 text-base-content/30 transition-transform {expanded
												? 'rotate-90'
												: ''}"
										/>
										<div class="min-w-0">
											<p
												class="truncate leading-tight font-semibold"
												title={String(record.path ?? '')}
											>
												{String(record.path ?? '')
													.split('/')
													.pop() || '-'}
											</p>
											<p class="truncate text-xs text-base-content/40">
												{String(record.path ?? '')
													.split('/')
													.slice(0, -1)
													.join('/')}
											</p>
										</div>
									</div>
								</td>
								<td class="whitespace-nowrap">
									<span class="badge badge-sm {reasonBadgeClass(String(record.reason ?? ''))}">
										{reasonLabel(String(record.reason ?? ''))}
									</span>
								</td>
								<td class="hidden text-sm sm:table-cell">
									{#if top}
										<span class="font-medium">{top.title}</span>
										{#if top.year}<span class="text-base-content/50"> ({top.year})</span>{/if}
									{:else}
										<span class="text-base-content/25">—</span>
									{/if}
								</td>
								<td
									class="hidden text-right font-mono text-sm font-bold tabular-nums sm:table-cell"
								>
									{#if top}
										{pct(top.confidence)}
									{:else}
										<span class="text-base-content/25">—</span>
									{/if}
								</td>
								<td class="hidden text-sm whitespace-nowrap text-base-content/50 sm:table-cell">
									{timeAgo(String(record.discoveredAt ?? ''))}
								</td>
								<td class="hidden sm:table-cell">
									<span class="text-lg leading-none text-base-content/30">···</span>
								</td>
							</tr>

							<!-- Expanded detail panel -->
							{#if expanded}
								<tr>
									<td colspan="7" class="border-b border-base-content/10 p-0">
										<!-- Full-width bg so it bleeds edge to edge; content indented to align under filename -->
										<div class="border-l-4 border-l-primary bg-base-200 py-5 pr-6 pl-10">
											<!-- Full file path banner -->
											<div
												class="mb-5 rounded-lg border border-base-content/12 bg-base-100 px-3 py-2.5 font-mono text-xs break-all"
											>
												<span class="mr-2 font-semibold text-base-content/50"
													>{m.reports_banner_source()}</span
												>
												<span class="text-base-content/80">{record.path ?? '-'}</span>
											</div>
											<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
												<!-- LEFT: Match candidates -->
												<div class="space-y-3">
													<h4
														class="text-[10px] font-bold tracking-widest text-base-content/50 uppercase"
													>
														{m.reports_unmatched_matchCandidates()}
													</h4>
													{#if candidates && candidates.length > 0}
														<div class="space-y-2">
															{#each candidates.slice(0, 5) as c, i (i)}
																<div
																	class="rounded-lg border border-base-content/12 bg-base-100 px-3 py-2.5 shadow-sm"
																>
																	<div class="flex items-center justify-between gap-2">
																		<div class="flex min-w-0 flex-wrap items-center gap-1.5">
																			<span class="text-sm font-semibold text-primary"
																				>{c.title}</span
																			>
																			{#if c.year}<span class="text-sm text-base-content/55"
																					>({c.year})</span
																				>{/if}
																			<span class="text-xs text-base-content/40"
																				>· tmdb:{c.tmdbId}</span
																			>
																			{#if i === 0}
																				<span class="badge badge-xs badge-primary">top</span>
																			{/if}
																		</div>
																		<span class="shrink-0 font-mono text-sm font-bold tabular-nums"
																			>{pct(c.confidence)}</span
																		>
																	</div>
																	<div class="mt-2">
																		<div
																			class="h-2 w-full overflow-hidden rounded-full bg-base-content/10"
																		>
																			<div
																				class="h-full rounded-full transition-all {barClass(
																					c.confidence
																				)}"
																				style="width:{Math.round(c.confidence * 100)}%"
																			></div>
																		</div>
																	</div>
																</div>
															{/each}
														</div>
													{:else}
														<div
															class="rounded-lg border border-dashed border-base-content/20 px-3 py-5 text-center"
														>
															<p class="text-sm text-base-content/50">
																{m.reports_unmatched_noCandidatesDetail()}
															</p>
														</div>
													{/if}

													<!-- Parsed tokens -->
													<div
														class="rounded-lg border border-base-content/12 bg-base-100 px-3 py-2.5 font-mono text-xs"
													>
														<span class="font-semibold text-base-content/50"
															>{m.reports_unmatched_parsedTokens()}
														</span>
														<span class="text-base-content/70">{parsedTokens(record)}</span>
														{#if record.ambiguityMargin != null}
															<span class="text-base-content/40">
																· margin {Number(record.ambiguityMargin).toFixed(2)}</span
															>
														{/if}
													</div>
												</div>

												<!-- RIGHT: File info + actions -->
												<div class="space-y-3">
													<h4
														class="text-[10px] font-bold tracking-widest text-base-content/50 uppercase"
													>
														File Details
													</h4>
													<!-- Details table -->
													<div
														class="overflow-hidden rounded-lg border border-base-content/12 bg-base-100 shadow-sm"
													>
														<div
															class="flex items-center justify-between border-b border-base-content/8 px-3 py-2.5 text-sm"
														>
															<span class="font-medium text-base-content/55"
																>{m.reports_detail_mediaType()}</span
															>
															<span class="badge badge-outline badge-sm"
																>{mediaTypeLabel(
																	record.mediaType as string | null | undefined
																)}</span
															>
														</div>
														{#if record.contentCategory && record.contentCategory !== 'main'}
															<div
																class="flex items-center justify-between border-b border-base-content/8 px-3 py-2.5 text-sm"
															>
																<span class="font-medium text-base-content/55"
																	>{m.reports_detail_category()}</span
																>
																<span class="font-semibold capitalize"
																	>{record.contentCategory}</span
																>
															</div>
														{/if}
														{#if record.size}
															<div
																class="flex items-center justify-between border-b border-base-content/8 px-3 py-2.5 text-sm"
															>
																<span class="font-medium text-base-content/55"
																	>{m.reports_detail_fileSize()}</span
																>
																<span class="font-semibold">{formatBytes(Number(record.size))}</span
																>
															</div>
														{/if}
														<div
															class="flex items-center justify-between px-3 py-2.5 text-sm {record.correlationId
																? 'border-b border-base-content/8'
																: ''}"
														>
															<span class="font-medium text-base-content/55"
																>{m.reports_detail_discovered()}</span
															>
															<span class="text-base-content/70"
																>{formatDate(String(record.discoveredAt ?? ''))}</span
															>
														</div>
														{#if record.correlationId}
															<div
																class="flex items-center justify-between gap-4 px-3 py-2.5 text-sm"
															>
																<span class="shrink-0 font-medium text-base-content/55"
																	>{m.reports_detail_correlationId()}</span
																>
																<span
																	class="truncate font-mono text-xs text-base-content/60 sm:overflow-visible sm:whitespace-normal"
																>
																	<span class="sm:hidden"
																		>{shortCorr(String(record.correlationId))}…</span
																	>
																	<span class="hidden sm:inline"
																		>{String(record.correlationId)}</span
																	>
																</span>
															</div>
														{/if}
													</div>

													<!-- Actions -->
													<div class="flex flex-wrap gap-2">
														{#if record.correlationId}
															<a
																href="/settings/monitoring/logs?correlationId={record.correlationId}"
																class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
																onclick={(e) => e.stopPropagation()}
																title="View logs for correlation ID {record.correlationId}"
															>
																<ExternalLink class="h-3 w-3" />
																View trace ({shortCorr(String(record.correlationId))})
															</a>
														{:else}
															<button
																class="btn cursor-not-allowed gap-1.5 border border-base-content/10 bg-base-100 text-base-content/30 btn-xs"
																disabled
																title="No trace available — this record was not correlated to a log session"
																onclick={(e) => e.stopPropagation()}
															>
																<ExternalLink class="h-3 w-3" />
																View trace
															</button>
														{/if}
														<button
															class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
															onclick={(e) => {
																e.stopPropagation();
																copyDiagnosticBundle(record);
															}}
														>
															<Copy class="h-3 w-3" />
															{m.reports_unmatched_copyBundle()}
														</button>
														{#if candidates && candidates.length > 0}
															<button
																class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
																onclick={(e) => {
																	e.stopPropagation();
																	forceMatch(record);
																}}
															>
																<Check class="h-3 w-3" />
																{m.reports_unmatched_forceMatch()}
															</button>
														{/if}
														<button
															class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
															onclick={(e) => {
																e.stopPropagation();
																matchModalRecord = record;
															}}
														>
															<Search class="h-3 w-3" />
															{m.reports_unmatched_setTitleManually()}
														</button>
													</div>
												</div>
											</div>
										</div>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
					{#if records.length < total}
						<tfoot>
							<tr>
								<td colspan="6" class="border-t border-base-content/8 py-2 text-center">
									<button
										class="btn btn-ghost text-base-content/50 btn-xs hover:text-base-content"
										onclick={() => appendRecords(activeTab, currentPage + 1)}
									>
										{m.reports_loadMore()}
									</button>
								</td>
							</tr>
						</tfoot>
					{/if}
				</table>
			</div>
		{/if}

		<!-- Match file modal (Set title manually) -->
		{#if matchModalRecord}
			<MatchFileModal
				open={!!matchModalRecord}
				file={matchModalRecord as {
					id: string;
					path: string;
					mediaType: string | null;
					parsedTitle: string | null;
					parsedYear: number | null;
					parsedSeason: number | null;
					parsedEpisode: number | null;
					suggestedMatches: unknown;
				}}
				onClose={() => {
					matchModalRecord = null;
				}}
				onSuccess={(fileId) => {
					records = records.filter((r) => r.id !== fileId);
					total = Math.max(0, total - 1);
					expandedId = null;
					matchModalRecord = null;
					refreshCounts();
					loadUnmatchedStats();
				}}
			/>
		{/if}

		<!-- REJECTED RELEASES SubTab -->
	{:else if activeTab === 'rejected-releases'}
		<!-- Stat cards -->
		{#if rejectedStats}
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
				<button
					class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all
						{activeRejectedStatCard === 'all'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyRejectedStatCard('all')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_rejected_stat_total()}
					</p>
					<p class="text-3xl font-bold text-error">{rejectedStats.total}</p>
				</button>
				<button
					class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all
						{activeRejectedStatCard === '24h'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyRejectedStatCard('24h')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_rejected_stat_newIn24h()}
					</p>
					<p
						class="text-3xl font-bold {rejectedStats.newIn24h > 0
							? 'text-warning'
							: 'text-success'}"
					>
						{rejectedStats.newIn24h}
					</p>
				</button>
				<button
					class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all
						{activeRejectedStatCard === 'format'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyRejectedStatCard('format')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_rejected_stat_formatMismatch()}
					</p>
					<p class="text-3xl font-bold">{rejectedStats.formatMismatch}</p>
				</button>
				<button
					class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all
						{activeRejectedStatCard === 'profile'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyRejectedStatCard('profile')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_rejected_stat_profileMismatch()}
					</p>
					<p class="text-3xl font-bold">{rejectedStats.profileMismatch}</p>
				</button>
				<button
					class="col-span-2 flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all sm:col-span-1
						{activeRejectedStatCard === 'delay'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyRejectedStatCard('delay')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_rejected_stat_delayPending()}
					</p>
					<p class="text-3xl font-bold text-info">{rejectedStats.delayPending}</p>
					<p class="text-[10px] leading-tight text-base-content/40">held by delay profile</p>
				</button>
			</div>
		{/if}

		<!-- Toolbar -->
		<div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
			<!-- Search -->
			<div class="group relative w-full sm:w-64">
				<div class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2">
					<Search
						class="h-4 w-4 text-base-content/40 transition-colors group-focus-within:text-primary"
					/>
				</div>
				<input
					type="text"
					class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
					placeholder={m.reports_search_releaseOrTitle()}
					bind:value={searchQuery}
					oninput={onSearchInput}
				/>
				{#if searchQuery}
					<button
						class="absolute top-1/2 right-3 -translate-y-1/2 text-base-content/40 hover:text-base-content"
						onclick={() => {
							searchQuery = '';
							loadRecords(activeTab, 1);
						}}
					>
						<X class="h-3.5 w-3.5" />
					</button>
				{/if}
			</div>

			<!-- Filters (inline on sm+) -->
			<div class="flex flex-wrap items-center gap-2">
				<!-- Media type pills -->
				<div class="flex items-center gap-1">
					{#each [{ value: '', label: m.reports_filter_all() }, { value: 'movie', label: m.reports_type_movie() }, { value: 'tv', label: m.reports_type_tv() }] as opt (opt)}
						<button
							class="btn font-medium btn-sm {mediaTypeFilter === opt.value
								? 'btn-primary'
								: 'btn-ghost'}"
							onclick={() => {
								mediaTypeFilter = opt.value;
								loadRecords(activeTab, 1);
							}}>{opt.label}</button
						>
					{/each}
				</div>

				<span class="h-4 w-px bg-base-content/15"></span>

				<select
					class="select w-40 border-base-content/20 bg-base-200 transition-all select-sm hover:bg-base-200 focus:border-primary/50 focus:outline-none"
					bind:value={reasonFilter}
					onchange={() => loadRecords(activeTab, 1)}
				>
					<option value="">{m.reports_filter_allReasons()}</option>
					<option value="required_format_mismatch"
						>{m.reports_rejected_reason_required_format_mismatch()}</option
					>
					<option value="quality_profile_mismatch"
						>{m.reports_rejected_reason_quality_profile_mismatch()}</option
					>
					<option value="delay_profile_pending"
						>{m.reports_rejected_reason_delay_profile_pending()}</option
					>
				</select>

				<select
					class="select w-32 border-base-content/20 bg-base-200 transition-all select-sm hover:bg-base-200 focus:border-primary/50 focus:outline-none"
					bind:value={dateFilter}
					onchange={() => loadRecords(activeTab, 1)}
				>
					{#each DATE_OPTIONS as opt (opt.value)}
						<option value={opt.value}>{opt.label}</option>
					{/each}
				</select>
			</div>

			<!-- Right side: count + bulk actions + export -->
			<div class="flex flex-col items-end gap-1.5 self-end sm:ml-auto">
				<span class="text-xs text-base-content/40 tabular-nums"
					>{m.reports_showing({ shown: records.length, total })}</span
				>
				<div class="flex flex-wrap items-center gap-2">
					{#if selectedIds.size > 0}
						<button class="btn gap-1.5 btn-sm btn-success" onclick={() => bulkResolve()}>
							<Check class="h-3.5 w-3.5" />
							{m.reports_resolveSelected({ count: selectedIds.size })}
						</button>
						<button
							class="btn gap-1.5 btn-outline btn-sm"
							onclick={() => {
								const sel = records.filter((r) => selectedIds.has(r.id));
								void copyToClipboard(JSON.stringify(sel, null, 2)).then((ok) => {
									if (ok) toasts.success(`${sel.length} items copied`);
									else toasts.error('Failed to copy');
								});
							}}
						>
							<Copy class="h-3.5 w-3.5" />
							{m.reports_copySelected()} ({selectedIds.size})
						</button>
					{/if}
					{#if total > 0}
						<button class="btn gap-1.5 btn-outline btn-error btn-sm" onclick={() => resolveAll()}>
							<Check class="h-3.5 w-3.5" />
							{m.reports_resolveAll({ count: total })}
						</button>
					{/if}
					<div class="relative">
						<button
							class="btn gap-1.5 btn-neutral btn-sm"
							disabled={records.length === 0}
							onclick={(e) => {
								e.stopPropagation();
								showExportMenu = !showExportMenu;
							}}
						>
							{m.reports_export()}
							<svg class="h-3 w-3" viewBox="0 0 12 12" fill="currentColor"
								><path d="M6 8L1 3h10z" /></svg
							>
						</button>
						{#if showExportMenu}
							<div
								class="absolute top-full right-0 z-20 mt-1 w-44 rounded-lg border border-base-300 bg-base-100 shadow-xl"
							>
								<button
									class="block w-full cursor-pointer rounded-t-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-base-200"
									onclick={() => {
										showExportMenu = false;
										const blob = new Blob(
											[
												'id,releaseTitle,mediaTitle,primaryReason,ruleFired,indexerName,protocol,rejectedAt\n' +
													records
														.map((r) =>
															[
																r.id,
																r.releaseTitle,
																r.mediaTitle,
																r.primaryReason,
																r.ruleFired,
																r.indexerName,
																r.protocol,
																r.rejectedAt
															]
																.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
																.join(',')
														)
														.join('\n')
											],
											{ type: 'text/csv' }
										);
										const url = URL.createObjectURL(blob);
										Object.assign(document.createElement('a'), {
											href: url,
											download: 'rejected-releases.csv'
										}).click();
										URL.revokeObjectURL(url);
									}}>{m.reports_exportCsv()}</button
								>
								<button
									class="block w-full cursor-pointer rounded-b-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-base-200"
									onclick={() => {
										showExportMenu = false;
										const blob = new Blob([JSON.stringify(records, null, 2)], {
											type: 'application/json'
										});
										const url = URL.createObjectURL(blob);
										Object.assign(document.createElement('a'), {
											href: url,
											download: 'rejected-releases.json'
										}).click();
										URL.revokeObjectURL(url);
									}}>{m.reports_exportJson()}</button
								>
							</div>
						{/if}
					</div>
				</div>
			</div>
		</div>

		<!-- Table -->
		{#if loading}
			<div class="flex items-center justify-center py-16">
				<Loader2 class="h-5 w-5 animate-spin text-base-content/40" />
				<span class="ml-2 text-sm text-base-content/60">{m.reports_loading()}</span>
			</div>
		{:else if records.length === 0}
			<div class="flex flex-col items-center justify-center py-20 text-center">
				<ShieldX class="mb-3 h-12 w-12 text-base-content/15" />
				<p class="font-medium text-base-content/60">{m.reports_empty()}</p>
				<p class="mt-1 text-sm text-base-content/40">{m.reports_emptyDescription()}</p>
			</div>
		{:else}
			<div class="overflow-x-auto rounded-lg border border-base-content/12 bg-base-100 shadow-sm">
				<table class="table w-full table-sm">
					<thead>
						<tr
							class="border-b border-base-content/10 bg-base-200 text-[11px] font-semibold tracking-widest text-base-content/50 uppercase"
						>
							<th class="w-8 pr-0">
								<input
									type="checkbox"
									class="checkbox checkbox-xs checkbox-primary"
									checked={selectedIds.size === records.length && records.length > 0}
									onchange={(e) => {
										selectedIds = (e.target as HTMLInputElement).checked
											? new Set(records.map((r) => r.id))
											: new Set();
									}}
								/>
							</th>
							<th>{m.reports_col_release()}</th>
							<th>{m.reports_col_reason()}</th>
							<th class="hidden sm:table-cell">{m.reports_col_ruleFired()}</th>
							<th class="hidden md:table-cell">{m.reports_col_indexer()}</th>
							<th class="hidden sm:table-cell">{m.reports_col_detected()}</th>
							<th class="hidden sm:table-cell"></th>
						</tr>
					</thead>
					<tbody class="divide-y divide-base-content/8">
						{#each records as record (record.id)}
							{@const expanded = expandedId === record.id}
							{@const checks = (record.rejectionReasons as RejectionCheck[] | null) ?? []}
							{@const isSelected = selectedIds.has(record.id)}
							<tr
								class="cursor-pointer transition-colors {isSelected
									? 'bg-primary/5'
									: 'hover:bg-base-200/50'}"
								onclick={() => (expandedId = expanded ? null : record.id)}
							>
								<td class="pr-0" onclick={(e) => e.stopPropagation()}>
									<input
										type="checkbox"
										class="checkbox checkbox-xs checkbox-primary"
										checked={isSelected}
										onchange={() => {
											const next = new Set(selectedIds);
											if (isSelected) {
												next.delete(record.id);
											} else {
												next.add(record.id);
											}
											selectedIds = next;
										}}
									/>
								</td>
								<td class="max-w-[42vw] sm:max-w-xs">
									<div class="flex items-start gap-1.5">
										<ChevronRight
											class="mt-0.5 h-3.5 w-3.5 shrink-0 text-base-content/30 transition-transform {expanded
												? 'rotate-90'
												: ''}"
										/>
										<div class="min-w-0">
											<p class="truncate leading-tight font-semibold">
												{record.releaseTitle ?? '-'}
											</p>
											{#if record.mediaTitle}
												<p class="truncate text-xs text-base-content/40">
													{record.mediaTitle}
												</p>
											{/if}
										</div>
									</div>
								</td>
								<td class="whitespace-nowrap">
									<span
										class="badge badge-sm {rejectedReasonBadgeClass(
											String(record.primaryReason ?? '')
										)}"
									>
										<span class="sm:hidden"
											>{rejectedReasonShortLabel(String(record.primaryReason ?? ''))}</span
										>
										<span class="hidden sm:inline"
											>{rejectedReasonLabel(String(record.primaryReason ?? ''))}</span
										>
									</span>
								</td>
								<td class="hidden max-w-50 text-sm text-base-content/70 sm:table-cell">
									<span class="line-clamp-1">{record.ruleFired ?? '-'}</span>
								</td>
								<td class="hidden text-sm whitespace-nowrap text-base-content/70 md:table-cell">
									{record.indexerName ?? '-'}
									{#if record.protocol}
										<span class="ml-1 badge badge-outline badge-xs uppercase"
											>{record.protocol}</span
										>
									{/if}
								</td>
								<td class="hidden text-sm whitespace-nowrap text-base-content/60 sm:table-cell">
									{timeAgo(String(record.rejectedAt ?? ''))}
								</td>
								<td class="hidden sm:table-cell">
									{#if record.status === 'overridden'}
										<span class="badge badge-ghost badge-xs">{m.reports_status_overridden()}</span>
									{/if}
								</td>
							</tr>

							{#if expanded}
								<tr>
									<td colspan="7" class="border-b border-base-content/10 p-0">
										<div class="border-l-4 border-l-primary bg-base-200 py-5 pr-6 pl-10">
											<!-- Full release filename -->
											<div
												class="mb-5 rounded-lg border border-base-content/12 bg-base-100 px-3 py-2.5 font-mono text-xs break-all"
											>
												<span class="mr-2 font-semibold text-base-content/50"
													>{m.reports_banner_release()}</span
												>
												<span class="text-base-content/80">{record.releaseTitle ?? '-'}</span>
											</div>

											<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
												<!-- LEFT: Format checks -->
												<div class="space-y-3">
													<h4
														class="text-[10px] font-bold tracking-widest text-base-content/50 uppercase"
													>
														{m.reports_rejected_formatChecks()}
													</h4>
													{#if checks.length > 0}
														<div class="space-y-2">
															{#each checks as check (check.rule)}
																<div
																	class="rounded-lg border {check.passed
																		? 'border-success/20 bg-success/5'
																		: 'border-base-content/12 bg-base-100'} px-3 py-2.5 shadow-sm"
																>
																	<div class="flex items-start gap-2">
																		{#if check.passed}
																			<Check class="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
																		{:else}
																			<X class="mt-0.5 h-3.5 w-3.5 shrink-0 text-error" />
																		{/if}
																		<div class="min-w-0">
																			<p
																				class="text-sm font-semibold {check.passed
																					? 'text-base-content/60'
																					: 'text-base-content'}"
																			>
																				{check.rule}
																			</p>
																			{#if check.detail}
																				<p class="mt-0.5 text-xs text-base-content/45">
																					{check.detail}
																				</p>
																			{/if}
																		</div>
																	</div>
																</div>
															{/each}
														</div>
													{:else}
														<div
															class="rounded-lg border border-dashed border-base-content/20 px-3 py-5 text-center"
														>
															<p class="text-sm text-base-content/50">
																{m.reports_detail_noCheckDetails()}
															</p>
														</div>
													{/if}
												</div>

												<!-- RIGHT: Release details + actions -->
												<div class="space-y-3">
													<h4
														class="text-[10px] font-bold tracking-widest text-base-content/50 uppercase"
													>
														Release Details
													</h4>
													<div
														class="overflow-hidden rounded-lg border border-base-content/12 bg-base-100 shadow-sm"
													>
														{#if record.mediaTitle}
															<div
																class="flex items-center justify-between border-b border-base-content/8 px-3 py-2.5 text-sm"
															>
																<span class="font-medium text-base-content/55"
																	>{m.reports_detail_media()}</span
																>
																<span class="font-semibold">{record.mediaTitle}</span>
															</div>
														{/if}
														{#if record.mediaType}
															<div
																class="flex items-center justify-between border-b border-base-content/8 px-3 py-2.5 text-sm"
															>
																<span class="font-medium text-base-content/55"
																	>{m.reports_detail_mediaType()}</span
																>
																<span class="badge badge-outline badge-sm"
																	>{mediaTypeLabel(
																		record.mediaType as string | null | undefined
																	)}</span
																>
															</div>
														{/if}
														{#if record.qualityProfileName}
															<div
																class="flex items-center justify-between border-b border-base-content/8 px-3 py-2.5 text-sm"
															>
																<span class="font-medium text-base-content/55"
																	>{m.reports_detail_profile()}</span
																>
																<span>{record.qualityProfileName}</span>
															</div>
														{/if}
														{#if record.releaseGroup}
															<div
																class="flex items-center justify-between border-b border-base-content/8 px-3 py-2.5 text-sm"
															>
																<span class="font-medium text-base-content/55"
																	>{m.reports_detail_group()}</span
																>
																<span class="font-mono text-xs">{record.releaseGroup}</span>
															</div>
														{/if}
														{#if record.releaseSize}
															<div
																class="flex items-center justify-between border-b border-base-content/8 px-3 py-2.5 text-sm"
															>
																<span class="font-medium text-base-content/55"
																	>{m.reports_detail_size()}</span
																>
																<span class="font-semibold"
																	>{formatBytes(Number(record.releaseSize))}</span
																>
															</div>
														{/if}
														<div
															class="flex items-center justify-between px-3 py-2.5 text-sm {record.correlationId
																? 'border-b border-base-content/8'
																: ''}"
														>
															<span class="font-medium text-base-content/55"
																>{m.reports_detail_rejected()}</span
															>
															<span class="text-base-content/70"
																>{formatDate(String(record.rejectedAt ?? ''))}</span
															>
														</div>
														{#if record.correlationId}
															<div
																class="flex items-center justify-between gap-4 px-3 py-2.5 text-sm"
															>
																<span class="shrink-0 font-medium text-base-content/55"
																	>{m.reports_detail_correlationId()}</span
																>
																<span class="truncate font-mono text-xs text-base-content/60">
																	<span class="sm:hidden"
																		>{shortCorr(String(record.correlationId))}…</span
																	>
																	<span class="hidden sm:inline"
																		>{String(record.correlationId)}</span
																	>
																</span>
															</div>
														{/if}
													</div>

													<!-- Actions -->
													<div class="flex flex-wrap gap-2">
														{#if record.correlationId}
															<a
																href="/settings/monitoring/logs?correlationId={record.correlationId}"
																class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
																onclick={(e) => e.stopPropagation()}
																title="View logs for correlation ID {record.correlationId}"
															>
																<ExternalLink class="h-3 w-3" />
																View trace ({shortCorr(String(record.correlationId))})
															</a>
														{:else}
															<button
																class="btn cursor-not-allowed gap-1.5 border border-base-content/10 bg-base-100 text-base-content/30 btn-xs"
																disabled
																onclick={(e) => e.stopPropagation()}
															>
																<ExternalLink class="h-3 w-3" />
																View trace
															</button>
														{/if}
														<button
															class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
															onclick={(e) => {
																e.stopPropagation();
																void copyRejectedBundle(record);
															}}
														>
															<Copy class="h-3 w-3" />
															{m.reports_rejected_copyBundle()}
														</button>
														<button
															class="btn btn-warning btn-xs"
															onclick={(e) => {
																e.stopPropagation();
																void overrideRejectedRelease(record);
															}}
														>
															<ShieldX class="h-3 w-3" />
															{m.reports_rejected_override()}
														</button>
														{#if record.status === 'overridden'}
															<button
																class="btn btn-success btn-xs"
																onclick={(e) => {
																	e.stopPropagation();
																	void resolveRecord(record.id);
																}}
															>
																<Check class="h-3 w-3" />
																{m.reports_dismiss()}
															</button>
														{:else}
															<button
																class="btn btn-success btn-xs"
																onclick={(e) => {
																	e.stopPropagation();
																	void resolveRecord(record.id);
																}}
															>
																<Check class="h-3 w-3" />
																{m.reports_resolve()}
															</button>
														{/if}
													</div>
												</div>
											</div>
										</div>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
					{#if totalPages > 1}
						<tfoot>
							<tr>
								<td colspan="7" class="border-t border-base-content/8 py-2">
									<div class="flex items-center justify-center gap-2">
										<button
											class="btn btn-ghost btn-xs"
											disabled={currentPage <= 1}
											onclick={() => loadRecords(activeTab, currentPage - 1)}
											>{m.reports_pagination_prev()}</button
										>
										<span class="text-xs text-base-content/60">{currentPage} / {totalPages}</span>
										<button
											class="btn btn-ghost btn-xs"
											disabled={currentPage >= totalPages}
											onclick={() => loadRecords(activeTab, currentPage + 1)}
											>{m.reports_pagination_next()}</button
										>
									</div>
								</td>
							</tr>
						</tfoot>
					{/if}
				</table>
			</div>
		{/if}

		<!-- IMPORT FAILURES SubTab -->
	{:else if activeTab === 'import-failures'}
		<!-- Stat cards -->
		{#if importStats}
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<button
					class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all
						{activeImportStatCard === 'all'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyImportStatCard('all')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_import_stat_total()}
					</p>
					<p class="text-3xl font-bold text-error">{importStats.total}</p>
				</button>
				<button
					class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all
						{activeImportStatCard === '24h'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyImportStatCard('24h')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_import_stat_newIn24h()}
					</p>
					<p
						class="text-3xl font-bold {importStats.newIn24h > 0 ? 'text-warning' : 'text-success'}"
					>
						{importStats.newIn24h}
					</p>
				</button>
				<button
					class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all
						{activeImportStatCard === 'transfer'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyImportStatCard('transfer')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_import_stat_transfer()}
					</p>
					<p class="text-3xl font-bold">{importStats.transfer}</p>
				</button>
				<button
					class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all
						{activeImportStatCard === 'disk_space'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyImportStatCard('disk_space')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_import_stat_diskSpace()}
					</p>
					<p class="text-3xl font-bold text-warning">{importStats.diskSpace}</p>
				</button>
			</div>
		{/if}

		<!-- Toolbar -->
		<div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
			<!-- Left side: search + filters -->
			<div class="group relative w-full sm:w-64">
				<div class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2">
					<Search
						class="h-4 w-4 text-base-content/40 transition-colors group-focus-within:text-primary"
					/>
				</div>
				<input
					type="text"
					class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
					placeholder={m.reports_search_releaseOrPath()}
					bind:value={searchQuery}
					oninput={onSearchInput}
				/>
				{#if searchQuery}
					<button
						class="absolute top-1/2 right-3 -translate-y-1/2 text-base-content/40 hover:text-base-content"
						onclick={() => {
							searchQuery = '';
							loadRecords('import-failures', 1);
						}}><X class="h-3.5 w-3.5" /></button
					>
				{/if}
			</div>
			<div class="hidden h-5 w-px bg-base-content/12 sm:block"></div>
			<select
				class="select w-full border-base-content/20 bg-base-200 select-sm sm:w-auto"
				bind:value={reasonFilter}
				onchange={() => loadRecords('import-failures', 1)}
			>
				<option value="">{m.reports_filter_allStages()}</option>
				<option value="path_resolution">{m.reports_stage_path_resolution()}</option>
				<option value="dangerous_files">{m.reports_stage_dangerous_files()}</option>
				<option value="disk_space">{m.reports_stage_disk_space()}</option>
				<option value="root_folder">{m.reports_stage_root_folder()}</option>
				<option value="library_entity">{m.reports_stage_library_entity()}</option>
				<option value="transfer">{m.reports_stage_transfer()}</option>
				<option value="max_retries">{m.reports_stage_max_retries()}</option>
			</select>
			<select
				class="select w-full border-base-content/20 bg-base-200 select-sm sm:w-auto"
				bind:value={dateFilter}
				onchange={() => loadRecords('import-failures', 1)}
			>
				{#each DATE_OPTIONS as opt (opt.value)}
					<option value={opt.value}>{opt.label}</option>
				{/each}
			</select>

			<!-- Right side: count + last refreshed + bulk actions + export -->
			<div class="flex flex-col items-end gap-1.5 self-end sm:ml-auto">
				<div class="flex items-center gap-2">
					<span class="text-xs text-base-content/40 tabular-nums"
						>{m.reports_showing({ shown: records.length, total })}</span
					>
					{#if lastRefreshed}
						<span
							class="hidden text-xs text-base-content/30 sm:inline"
							title="Auto-refreshes every 60s"
						>
							· refreshed {timeAgo(lastRefreshed.toISOString())}
						</span>
					{/if}
				</div>
				<div class="flex flex-wrap items-center gap-2">
					{#if selectedIds.size > 0}
						<button class="btn gap-1.5 btn-sm btn-success" onclick={() => bulkResolve()}>
							<Check class="h-3.5 w-3.5" />
							{m.reports_resolveSelected({ count: selectedIds.size })}
						</button>
						<button
							class="btn gap-1.5 btn-outline btn-sm"
							onclick={() => {
								const sel = records.filter((r) => selectedIds.has(r.id));
								void copyToClipboard(JSON.stringify(sel, null, 2)).then((ok) => {
									if (ok) toasts.success(`${sel.length} items copied`);
									else toasts.error('Failed to copy');
								});
							}}
						>
							<Copy class="h-3.5 w-3.5" />
							{m.reports_copySelected()} ({selectedIds.size})
						</button>
					{/if}
					{#if total > 0}
						<button class="btn gap-1.5 btn-outline btn-error btn-sm" onclick={() => resolveAll()}>
							<Check class="h-3.5 w-3.5" />
							{m.reports_resolveAll({ count: total })}
						</button>
					{/if}
					<div class="relative">
						<button
							class="btn gap-1.5 btn-neutral btn-sm"
							disabled={records.length === 0}
							onclick={(e) => {
								e.stopPropagation();
								showExportMenu = !showExportMenu;
							}}
						>
							{m.reports_export()}
							<svg class="h-3 w-3" viewBox="0 0 12 12" fill="currentColor"
								><path d="M6 8L1 3h10z" /></svg
							>
						</button>
						{#if showExportMenu}
							<div
								class="absolute top-full right-0 z-20 mt-1 w-44 rounded-lg border border-base-300 bg-base-100 shadow-xl"
							>
								<button
									class="block w-full cursor-pointer rounded-t-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-base-200"
									onclick={() => {
										showExportMenu = false;
										const blob = new Blob(
											[
												'id,releaseTitle,sourcePath,failureStage,reason,attemptCount,failedAt\n' +
													records
														.map((r) =>
															[
																r.id,
																r.releaseTitle,
																r.sourcePath,
																r.failureStage,
																r.reason,
																r.attemptCount,
																r.failedAt
															]
																.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
																.join(',')
														)
														.join('\n')
											],
											{ type: 'text/csv' }
										);
										const url = URL.createObjectURL(blob);
										Object.assign(document.createElement('a'), {
											href: url,
											download: 'import-failures.csv'
										}).click();
										URL.revokeObjectURL(url);
									}}>{m.reports_exportCsv()}</button
								>
								<button
									class="block w-full cursor-pointer rounded-b-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-base-200"
									onclick={() => {
										showExportMenu = false;
										const blob = new Blob([JSON.stringify(records, null, 2)], {
											type: 'application/json'
										});
										const url = URL.createObjectURL(blob);
										Object.assign(document.createElement('a'), {
											href: url,
											download: 'import-failures.json'
										}).click();
										URL.revokeObjectURL(url);
									}}>{m.reports_exportJson()}</button
								>
							</div>
						{/if}
					</div>
				</div>
			</div>
		</div>

		{#if loading}
			<div class="flex items-center justify-center py-16">
				<Loader2 class="h-5 w-5 animate-spin text-base-content/40" />
				<span class="ml-2 text-sm text-base-content/60">{m.reports_loading()}</span>
			</div>
		{:else if records.length === 0}
			<div class="flex flex-col items-center justify-center py-20 text-center">
				<AlertTriangle class="mb-3 h-12 w-12 text-base-content/15" />
				<p class="font-medium text-base-content/60">{m.reports_empty()}</p>
				<p class="mt-1 text-sm text-base-content/40">{m.reports_emptyDescription()}</p>
			</div>
		{:else}
			<div class="overflow-x-auto rounded-lg border border-base-content/12 bg-base-100 shadow-sm">
				<table class="table w-full table-sm">
					<thead>
						<tr
							class="border-b border-base-content/10 bg-base-200 text-[11px] font-semibold tracking-widest text-base-content/50 uppercase"
						>
							<th class="w-8 pr-0">
								<input
									type="checkbox"
									class="checkbox checkbox-xs checkbox-primary"
									checked={selectedIds.size === records.length && records.length > 0}
									onchange={(e) => {
										selectedIds = (e.target as HTMLInputElement).checked
											? new Set(records.map((r) => r.id))
											: new Set();
									}}
								/>
							</th>
							<th>{m.reports_col_release()}</th>
							<th class="hidden sm:table-cell">{m.reports_col_stage()}</th>
							<th class="hidden md:table-cell">{m.reports_col_reason()}</th>
							<th class="hidden sm:table-cell">{m.reports_col_date()}</th>
							<th>{m.reports_col_status()}</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-base-content/8">
						{#each records as record (record.id)}
							{@const expanded = expandedId === record.id}
							{@const isSelected = selectedIds.has(record.id)}
							<tr
								class="cursor-pointer transition-colors {isSelected
									? 'bg-primary/5'
									: 'hover:bg-base-200/50'}"
								onclick={() => (expandedId = expanded ? null : record.id)}
							>
								<td class="pr-0" onclick={(e) => e.stopPropagation()}>
									<input
										type="checkbox"
										class="checkbox checkbox-xs checkbox-primary"
										checked={isSelected}
										onchange={() => {
											const next = new Set(selectedIds);
											if (isSelected) next.delete(record.id);
											else next.add(record.id);
											selectedIds = next;
										}}
									/>
								</td>
								<td class="max-w-[42vw] sm:max-w-xs">
									<div class="flex items-start gap-1.5">
										<ChevronRight
											class="mt-0.5 h-3.5 w-3.5 shrink-0 text-base-content/30 transition-transform {expanded
												? 'rotate-90'
												: ''}"
										/>
										<div class="min-w-0">
											<p class="truncate leading-tight font-semibold">
												{record.releaseTitle ?? '-'}
											</p>
											<p class="truncate text-xs text-base-content/40 sm:hidden">
												{stageLabel(String(record.failureStage ?? ''))}
											</p>
										</div>
									</div>
								</td>
								<td class="hidden whitespace-nowrap sm:table-cell">
									<span class="badge badge-sm badge-warning"
										>{stageLabel(String(record.failureStage ?? ''))}</span
									>
								</td>
								<td class="hidden max-w-50 text-sm text-base-content/70 md:table-cell">
									<span class="line-clamp-1">{record.reasonDetail ?? record.reason ?? '-'}</span>
								</td>
								<td class="hidden text-sm whitespace-nowrap text-base-content/60 sm:table-cell">
									{timeAgo(String(record.failedAt ?? ''))}
								</td>
								<td>
									<div class="flex items-center gap-1.5">
										<span class="badge badge-sm {statusBadgeClass(String(record.status ?? ''))}"
											>{statusLabel(String(record.status ?? ''))}</span
										>
										{#if ((record.attemptCount as number | undefined) ?? 1) >= 3}
											<span class="badge badge-sm badge-error">{record.attemptCount}×</span>
										{/if}
									</div>
								</td>
							</tr>

							{#if expanded}
								<tr>
									<td colspan="6" class="border-b border-base-content/10 p-0">
										<div class="border-l-4 border-l-primary bg-base-200 py-5 pr-6 pl-10">
											{#if record.sourcePath}
												<div
													class="mb-5 rounded-lg border border-base-content/12 bg-base-100 px-3 py-2.5 font-mono text-xs break-all"
												>
													<span class="mr-2 font-semibold text-base-content/50"
														>{m.reports_banner_source()}</span
													>
													<span class="text-base-content/80">{record.sourcePath}</span>
												</div>
											{/if}

											<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
												<!-- LEFT: Error details -->
												<div class="space-y-3">
													<h4
														class="text-[10px] font-bold tracking-widest text-base-content/50 uppercase"
													>
														{m.reports_section_errorDetails()}
													</h4>
													{#if record.reasonDetail || record.reason}
														<div
															class="rounded-lg border border-error/20 bg-error/5 px-3 py-2.5 shadow-sm"
														>
															<div class="flex items-start gap-2">
																<X class="mt-0.5 h-3.5 w-3.5 shrink-0 text-error" />
																<div class="min-w-0">
																	<p class="text-sm font-semibold text-base-content">
																		{record.reasonDetail ?? record.reason}
																	</p>
																	{#if record.reasonDetail && record.reason && record.reasonDetail !== record.reason}
																		<p class="mt-0.5 text-xs text-base-content/45">
																			{record.reason}
																		</p>
																	{/if}
																</div>
															</div>
														</div>
													{/if}
													{#if Array.isArray(record.dangerousFiles) && record.dangerousFiles.length > 0}
														<div
															class="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2.5"
														>
															<p class="mb-1.5 text-xs font-semibold text-warning">
																{m.reports_detail_blockedFiles()}
															</p>
															<ul class="space-y-0.5 font-mono text-xs text-base-content/70">
																{#each record.dangerousFiles as f (f)}<li>
																		{f.path}
																		<span class="text-base-content/40">({f.extension})</span>
																	</li>{/each}
															</ul>
														</div>
													{/if}
													{#if !record.reasonDetail && !record.reason && !(Array.isArray(record.dangerousFiles) && record.dangerousFiles.length > 0)}
														<div
															class="rounded-lg border border-dashed border-base-content/20 px-3 py-5 text-center"
														>
															<p class="text-sm text-base-content/50">
																{m.reports_detail_noErrorDetails()}
															</p>
														</div>
													{/if}
												</div>

												<!-- RIGHT: Import details + actions -->
												<div class="space-y-3">
													<h4
														class="text-[10px] font-bold tracking-widest text-base-content/50 uppercase"
													>
														Import Details
													</h4>
													<div
														class="overflow-hidden rounded-lg border border-base-content/12 bg-base-100 shadow-sm"
													>
														<div
															class="flex items-center justify-between border-b border-base-content/8 px-3 py-2.5 text-sm"
														>
															<span class="font-medium text-base-content/55"
																>{m.reports_detail_stage()}</span
															>
															<span class="badge badge-sm badge-warning"
																>{stageLabel(String(record.failureStage ?? ''))}</span
															>
														</div>
														{#if (record as Record<string, unknown>).downloadClientName}
															<div
																class="flex items-center justify-between border-b border-base-content/8 px-3 py-2.5 text-sm"
															>
																<span class="font-medium text-base-content/55"
																	>{m.reports_import_detail_client()}</span
																>
																<span class="font-mono text-xs text-base-content/80"
																	>{(record as Record<string, unknown>)
																		.downloadClientName as string}</span
																>
															</div>
														{/if}
														{#if record.destinationPath}
															<div
																class="flex items-center justify-between border-b border-base-content/8 px-3 py-2.5 text-sm"
															>
																<span class="shrink-0 font-medium text-base-content/55"
																	>{m.reports_detail_destination()}</span
																>
																<span class="ml-4 truncate text-right font-mono text-xs"
																	>{record.destinationPath}</span
																>
															</div>
														{/if}
														<div
															class="flex items-center justify-between border-b border-base-content/8 px-3 py-2.5 text-sm"
														>
															<span class="font-medium text-base-content/55"
																>{m.reports_detail_attempts()}</span
															>
															<span
																class="font-semibold {((record.attemptCount as
																	number | undefined) ?? 1) >= 5
																	? 'text-error'
																	: ''}">{record.attemptCount ?? 1}</span
															>
														</div>
														<div
															class="flex items-center justify-between px-3 py-2.5 text-sm {record.correlationId
																? 'border-b border-base-content/8'
																: ''}"
														>
															<span class="font-medium text-base-content/55"
																>{m.reports_detail_failed()}</span
															>
															<span class="text-base-content/70"
																>{formatDate(String(record.failedAt ?? ''))}</span
															>
														</div>
														{#if record.correlationId}
															<div
																class="flex items-center justify-between gap-4 px-3 py-2.5 text-sm"
															>
																<span class="shrink-0 font-medium text-base-content/55"
																	>{m.reports_detail_correlationId()}</span
																>
																<span class="truncate font-mono text-xs text-base-content/60">
																	<span class="sm:hidden"
																		>{shortCorr(String(record.correlationId))}…</span
																	>
																	<span class="hidden sm:inline"
																		>{String(record.correlationId)}</span
																	>
																</span>
															</div>
														{/if}
													</div>

													<!-- Actions -->
													<div class="flex flex-wrap gap-2">
														{#if record.correlationId}
															<a
																href="/settings/monitoring/logs?correlationId={record.correlationId}"
																class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
																onclick={(e) => e.stopPropagation()}
															>
																<ExternalLink class="h-3 w-3" />
																View trace ({shortCorr(String(record.correlationId))})
															</a>
														{:else}
															<button
																class="btn cursor-not-allowed gap-1.5 border border-base-content/10 bg-base-100 text-base-content/30 btn-xs"
																disabled
																onclick={(e) => e.stopPropagation()}
															>
																<ExternalLink class="h-3 w-3" />
																View trace
															</button>
														{/if}
														<button
															class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
															onclick={(e) => {
																e.stopPropagation();
																void copyImportBundle(record as Record<string, unknown>);
															}}
														>
															<Copy class="h-3 w-3" />
															{m.reports_import_copyBundle()}
														</button>
														{#if record.status === 'failed'}
															<button
																class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
																onclick={async (e) => {
																	e.stopPropagation();
																	const res = await fetch(
																		`/api/reports/import-failures/${record.id}/retry`,
																		{ method: 'POST' }
																	);
																	const result = await res.json();
																	if (result.success)
																		toasts.success(m.reports_import_retry_queued());
																	else toasts.error(m.reports_import_retry_failed());
																	if (result.success) loadRecords('import-failures', currentPage);
																}}
															>
																<RefreshCw class="h-3 w-3" />
																{m.reports_import_retry()}
															</button>
														{/if}
														{#if record.status !== 'resolved'}
															<button
																class="btn gap-1.5 btn-success btn-xs"
																onclick={(e) => {
																	e.stopPropagation();
																	void resolveRecord(record.id);
																}}
															>
																<Check class="h-3 w-3" />
																{m.reports_resolve()}
															</button>
														{/if}
													</div>
												</div>
											</div>
										</div>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
					{#if totalPages > 1}
						<tfoot>
							<tr>
								<td colspan="6" class="border-t border-base-content/8 py-2">
									<div class="flex items-center justify-center gap-2">
										<button
											class="btn btn-ghost btn-xs"
											disabled={currentPage <= 1}
											onclick={() => loadRecords('import-failures', currentPage - 1)}
											>{m.reports_pagination_prev()}</button
										>
										<span class="text-xs text-base-content/60">{currentPage} / {totalPages}</span>
										<button
											class="btn btn-ghost btn-xs"
											disabled={currentPage >= totalPages}
											onclick={() => loadRecords('import-failures', currentPage + 1)}
											>{m.reports_pagination_next()}</button
										>
									</div>
								</td>
							</tr>
						</tfoot>
					{/if}
				</table>
			</div>
		{/if}
		<!-- RENAMING FAILURES SubTab -->
	{:else if activeTab === 'renaming-failures'}
		{#if renamingStats}
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<button
					class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all
						{activeRenamingStatCard === 'all'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyRenamingStatCard('all')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_renaming_stat_total()}
					</p>
					<p class="text-3xl font-bold text-error">{renamingStats.total}</p>
				</button>
				<button
					class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all
						{activeRenamingStatCard === '24h'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyRenamingStatCard('24h')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_renaming_stat_newIn24h()}
					</p>
					<p
						class="text-3xl font-bold {renamingStats.newIn24h > 0
							? 'text-warning'
							: 'text-success'}"
					>
						{renamingStats.newIn24h}
					</p>
				</button>
				<button
					class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all
						{activeRenamingStatCard === 'collision'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyRenamingStatCard('collision')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_renaming_stat_collisions()}
					</p>
					<p class="text-3xl font-bold">{renamingStats.collisions}</p>
				</button>
				<button
					class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all
						{activeRenamingStatCard === 'permissionIo'
						? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30'
						: 'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80'}"
					onclick={() => applyRenamingStatCard('permissionIo')}
				>
					<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
						{m.reports_renaming_stat_permissionIo()}
					</p>
					<p class="text-3xl font-bold {renamingStats.permissionIo > 0 ? 'text-warning' : ''}">
						{renamingStats.permissionIo}
					</p>
				</button>
			</div>
		{/if}

		<div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
			<div class="group relative w-full sm:w-64">
				<div class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2">
					<Search
						class="h-4 w-4 text-base-content/40 transition-colors group-focus-within:text-primary"
					/>
				</div>
				<input
					type="text"
					class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
					placeholder={m.reports_search_sourceOrPath()}
					bind:value={searchQuery}
					oninput={onSearchInput}
				/>
				{#if searchQuery}
					<button
						class="absolute top-1/2 right-3 -translate-y-1/2 text-base-content/40 hover:text-base-content"
						onclick={() => {
							searchQuery = '';
							loadRecords('renaming-failures', 1);
						}}
					>
						<X class="h-3.5 w-3.5" />
					</button>
				{/if}
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<div class="flex items-center gap-1">
					{#each [{ value: '', label: m.reports_filter_all() }, { value: 'movie', label: m.reports_type_movie() }, { value: 'episode', label: m.reports_type_tv() }] as opt (opt.value)}
						<button
							class="btn font-medium btn-sm {renamingFileTypeFilter === opt.value
								? 'btn-primary'
								: 'btn-ghost'}"
							onclick={() => {
								renamingFileTypeFilter = opt.value;
								loadRecords('renaming-failures', 1);
							}}>{opt.label}</button
						>
					{/each}
				</div>
				<span class="hidden h-4 w-px bg-base-content/15 sm:block"></span>
				<select
					class="select w-44 border-base-content/20 bg-base-200 transition-all select-sm hover:bg-base-200 focus:border-primary/50 focus:outline-none"
					bind:value={reasonFilter}
					onchange={() => loadRecords('renaming-failures', 1)}
				>
					<option value="">{m.reports_filter_allReasons()}</option>
					<option value="collision">{m.reports_renaming_reason_collision()}</option>
					<option value="io_error">{m.reports_renaming_reason_ioError()}</option>
					<option value="permission_denied">{m.reports_renaming_reason_permissionDenied()}</option>
					<option value="source_not_found">{m.reports_renaming_reason_sourceNotFound()}</option>
					<option value="path_too_long">{m.reports_renaming_reason_pathTooLong()}</option>
					<option value="invalid_chars">{m.reports_renaming_reason_invalidChars()}</option>
					<option value="disk_full">{m.reports_renaming_reason_diskFull()}</option>
					<option value="preview_error">{m.reports_renaming_reason_previewError()}</option>
				</select>
				<select
					class="select w-32 border-base-content/20 bg-base-200 transition-all select-sm hover:bg-base-200 focus:border-primary/50 focus:outline-none"
					bind:value={dateFilter}
					onchange={() => loadRecords('renaming-failures', 1)}
				>
					{#each DATE_OPTIONS as opt (opt.value)}<option value={opt.value}>{opt.label}</option
						>{/each}
				</select>
			</div>
			<div class="flex flex-col items-end gap-1.5 self-end sm:ml-auto">
				<span class="text-xs text-base-content/40 tabular-nums"
					>{m.reports_showing({ shown: records.length, total })}</span
				>
				<div class="flex flex-wrap items-center gap-2">
					{#if selectedIds.size > 0}
						<button class="btn gap-1.5 btn-sm btn-success" onclick={() => bulkResolve()}>
							<Check class="h-3.5 w-3.5" />
							{m.reports_resolveSelected({ count: selectedIds.size })}
						</button>
						<button
							class="btn gap-1.5 btn-outline btn-sm"
							onclick={() => {
								const sel = records.filter((r) => selectedIds.has(r.id));
								void copyToClipboard(JSON.stringify(sel, null, 2)).then((ok) => {
									if (ok) toasts.success(`${sel.length} items copied`);
									else toasts.error('Failed to copy');
								});
							}}
						>
							<Copy class="h-3.5 w-3.5" />
							{m.reports_copySelected()} ({selectedIds.size})
						</button>
					{/if}
					{#if total > 0}
						<button class="btn gap-1.5 btn-outline btn-error btn-sm" onclick={() => resolveAll()}>
							<Check class="h-3.5 w-3.5" />
							{m.reports_resolveAll({ count: total })}
						</button>
					{/if}
					<div class="relative">
						<button
							class="btn gap-1.5 btn-neutral btn-sm"
							disabled={records.length === 0}
							onclick={(e) => {
								e.stopPropagation();
								showExportMenu = !showExportMenu;
							}}
						>
							{m.reports_export()}
							<svg class="h-3 w-3" viewBox="0 0 12 12" fill="currentColor"
								><path d="M6 8L1 3h10z" /></svg
							>
						</button>
						{#if showExportMenu}
							<div
								class="absolute top-full right-0 z-20 mt-1 w-44 rounded-lg border border-base-300 bg-base-100 shadow-xl"
							>
								<button
									class="block w-full cursor-pointer rounded-t-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-base-200"
									onclick={() => {
										showExportMenu = false;
										const blob = new Blob(
											[
												'id,sourcePath,intendedPath,fileType,reason,reasonDetail,failedAt\n' +
													records
														.map((r) =>
															[
																r.id,
																r.sourcePath,
																r.intendedPath,
																r.fileType,
																r.reason,
																r.reasonDetail,
																r.failedAt
															]
																.map((v) => `"${String(v ?? '')}"`)
																.join(',')
														)
														.join('\n')
											],
											{ type: 'text/csv' }
										);
										const url = URL.createObjectURL(blob);
										Object.assign(document.createElement('a'), {
											href: url,
											download: 'renaming-failures.csv'
										}).click();
										URL.revokeObjectURL(url);
									}}>{m.reports_exportCsv()}</button
								>
								<button
									class="block w-full cursor-pointer rounded-b-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-base-200"
									onclick={() => {
										showExportMenu = false;
										const blob = new Blob([JSON.stringify(records, null, 2)], {
											type: 'application/json'
										});
										const url = URL.createObjectURL(blob);
										Object.assign(document.createElement('a'), {
											href: url,
											download: 'renaming-failures.json'
										}).click();
										URL.revokeObjectURL(url);
									}}>{m.reports_exportJson()}</button
								>
							</div>
						{/if}
					</div>
				</div>
			</div>
		</div>

		{#if loading}
			<div class="flex items-center justify-center py-16">
				<Loader2 class="h-5 w-5 animate-spin text-base-content/40" /><span
					class="ml-2 text-sm text-base-content/60">{m.reports_loading()}</span
				>
			</div>
		{:else if records.length === 0}
			<div class="flex flex-col items-center justify-center py-20 text-center">
				<FileX class="mb-3 h-12 w-12 text-base-content/15" />
				<p class="font-medium text-base-content/60">{m.reports_empty()}</p>
				<p class="mt-1 text-sm text-base-content/40">{m.reports_emptyDescription()}</p>
			</div>
		{:else}
			<div class="overflow-x-auto rounded-lg border border-base-content/12 bg-base-100 shadow-sm">
				<table class="table w-full table-sm">
					<thead>
						<tr
							class="border-b border-base-content/10 bg-base-200 text-[11px] font-semibold tracking-widest text-base-content/50 uppercase"
						>
							<th class="w-8 pr-0"
								><input
									type="checkbox"
									class="checkbox checkbox-xs checkbox-primary"
									checked={selectedIds.size === records.length && records.length > 0}
									onchange={(e) => {
										selectedIds = (e.target as HTMLInputElement).checked
											? new Set(records.map((r) => r.id))
											: new Set();
									}}
								/></th
							>
							<th>{m.reports_col_file()}</th>
							<th class="hidden sm:table-cell">{m.reports_col_type()}</th>
							<th>{m.reports_col_reason()}</th>
							<th class="hidden sm:table-cell">{m.reports_col_date()}</th>
							<th>{m.reports_col_status()}</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-base-content/8">
						{#each records as record (record.id)}
							{@const expanded = expandedId === record.id}
							{@const isSelected = selectedIds.has(record.id)}
							<tr
								class="cursor-pointer transition-colors {isSelected
									? 'bg-primary/5'
									: 'hover:bg-base-200/50'}"
								onclick={() => (expandedId = expanded ? null : record.id)}
							>
								<td class="pr-0" onclick={(e) => e.stopPropagation()}>
									<input
										type="checkbox"
										class="checkbox checkbox-xs checkbox-primary"
										checked={isSelected}
										onchange={() => {
											const next = new Set(selectedIds);
											if (isSelected) next.delete(record.id);
											else next.add(record.id);
											selectedIds = next;
										}}
									/>
								</td>

								<td class="max-w-[42vw] sm:max-w-xs">
									<div class="flex items-start gap-1.5">
										<ChevronRight
											class="mt-0.5 h-3.5 w-3.5 shrink-0 text-base-content/30 transition-transform {expanded
												? 'rotate-90'
												: ''}"
										/>
										<div class="min-w-0">
											<p
												class="truncate text-xs font-medium"
												title={String(record.sourcePath ?? '')}
											>
												{String(record.sourcePath ?? '')
													.split('/')
													.pop() ?? record.sourcePath}
											</p>
											<p
												class="truncate font-mono text-[12px] text-base-content/40"
												title={String(record.intendedPath ?? '')}
											>
												&#x2192; {String(record.intendedPath ?? '')
													.split('/')
													.pop() ?? record.intendedPath}
											</p>
										</div>
									</div>
								</td>
								<td class="hidden sm:table-cell">
									<span class="badge badge-outline badge-sm"
										>{fileTypeLabel(String(record.fileType ?? ''))}</span
									>
								</td>
								<td
									><span
										class="badge badge-sm {renamingReasonBadgeClass(String(record.reason ?? ''))}"
										><span class="sm:hidden"
											>{renamingReasonShortLabel(String(record.reason ?? ''))}</span
										><span class="hidden sm:inline"
											>{renamingReasonLabel(String(record.reason ?? ''))}</span
										></span
									></td
								>
								<td class="hidden text-xs text-base-content/60 sm:table-cell"
									>{formatDate(String(record.failedAt ?? ''))}</td
								>
								<td
									><span class="badge badge-sm {statusBadgeClass(String(record.status ?? ''))}"
										>{statusLabel(String(record.status ?? ''))}</span
									></td
								>
							</tr>

							{#if expanded}
								<tr>
									<td colspan="6" class="border-b border-base-content/10 p-0">
										<div class="border-l-4 border-l-primary bg-base-200 py-5 pr-6 pl-10">
											<div
												class="mb-2 rounded-lg border border-base-content/12 bg-base-100 px-3 py-2.5 font-mono text-xs break-all"
											>
												<span class="mr-2 font-semibold text-base-content/50"
													>{m.reports_banner_source()}</span
												>
												<span class="text-base-content/80">{record.sourcePath}</span>
											</div>
											<div
												class="mb-5 rounded-lg border border-base-content/12 bg-base-100 px-3 py-2.5 font-mono text-xs break-all"
											>
												<span class="mr-2 font-semibold text-base-content/50"
													>{m.reports_renaming_intended()}</span
												>
												<span class="text-base-content/80">{record.intendedPath}</span>
											</div>

											<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
												<div class="space-y-3">
													<h4
														class="text-[10px] font-bold tracking-widest text-base-content/50 uppercase"
													>
														{m.reports_section_errorDetails()}
													</h4>
													<div
														class="rounded-lg border border-error/20 bg-error/5 px-3 py-2.5 shadow-sm"
													>
														<div class="flex items-start gap-2">
															<X class="mt-0.5 h-3.5 w-3.5 shrink-0 text-error" />
															<div class="min-w-0">
																<p class="text-sm font-semibold text-base-content">
																	{record.reasonDetail ??
																		renamingReasonLabel(String(record.reason ?? ''))}
																</p>
																{#if record.reasonDetail}<p
																		class="mt-0.5 text-xs text-base-content/45"
																	>
																		{renamingReasonLabel(String(record.reason ?? ''))}
																	</p>{/if}
															</div>
														</div>
													</div>
												</div>

												<div class="space-y-3">
													<h4
														class="text-[10px] font-bold tracking-widest text-base-content/50 uppercase"
													>
														{m.reports_section_renameDetails()}
													</h4>
													<div
														class="overflow-hidden rounded-lg border border-base-content/12 bg-base-100 shadow-sm"
													>
														<div
															class="flex items-center justify-between border-b border-base-content/8 px-3 py-2.5 text-sm"
														>
															<span class="font-medium text-base-content/55"
																>{m.reports_col_type()}</span
															>
															<span class="badge badge-outline badge-sm"
																>{fileTypeLabel(String(record.fileType ?? ''))}</span
															>
														</div>
														<div
															class="flex items-center justify-between border-b border-base-content/8 px-3 py-2.5 text-sm"
														>
															<span class="font-medium text-base-content/55"
																>{m.reports_detail_failed()}</span
															>
															<span class="text-base-content/70"
																>{formatDate(String(record.failedAt ?? ''))}</span
															>
														</div>
														{#if record.correlationId}
															<div
																class="flex items-center justify-between gap-4 px-3 py-2.5 text-sm"
															>
																<span class="shrink-0 font-medium text-base-content/55"
																	>{m.reports_detail_correlationId()}</span
																>
																<span class="truncate font-mono text-xs text-base-content/60"
																	><span class="sm:hidden"
																		>{shortCorr(String(record.correlationId))}&#x2026;</span
																	><span class="hidden sm:inline"
																		>{String(record.correlationId)}</span
																	></span
																>
															</div>
														{/if}
													</div>

													<div class="flex flex-wrap gap-2">
														{#if record.correlationId}
															<a
																href="/settings/monitoring/logs?correlationId={record.correlationId}"
																class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
																onclick={(e) => e.stopPropagation()}
																><ExternalLink class="h-3 w-3" /> View trace ({shortCorr(
																	String(record.correlationId)
																)})</a
															>
														{/if}
														<button
															class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
															onclick={(e) => {
																e.stopPropagation();
																void copyRenamingBundle(record as Record<string, unknown>);
															}}
														>
															<Copy class="h-3 w-3" />
															{m.reports_renaming_copyBundle()}
														</button>
														{#if record.status !== 'resolved'}
															{#if record.reason === 'path_too_long' || record.reason === 'invalid_chars'}
																<a
																	href="/settings/library/naming"
																	class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
																	onclick={(e) => e.stopPropagation()}
																	><Settings class="h-3 w-3" />
																	{m.reports_renaming_fixTemplate()}</a
																>
															{:else if record.reason !== 'source_not_found'}
																<button
																	class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
																	onclick={async (e) => {
																		e.stopPropagation();
																		const res = await fetch(
																			`/api/reports/renaming-failures/${record.id}/retry`,
																			{ method: 'POST' }
																		);
																		const result = await res.json();
																		if (result.success) {
																			toasts.success(m.reports_renaming_retrySuccess());
																			loadRecords('renaming-failures', currentPage);
																			loadRenamingStats();
																		} else
																			toasts.error(
																				result.error ?? m.reports_renaming_retryFailed()
																			);
																	}}
																>
																	<RefreshCw class="h-3 w-3" />
																	{m.reports_renaming_retry()}
																</button>
															{/if}
															<button
																class="btn gap-1.5 btn-success btn-xs"
																onclick={(e) => {
																	e.stopPropagation();
																	void resolveRecord(record.id);
																}}><Check class="h-3 w-3" /> {m.reports_resolve()}</button
															>
														{/if}
														{#if record.reason === 'source_not_found' && record.status !== 'resolved'}
															<p class="mt-1 w-full text-xs text-base-content/45">
																{m.reports_renaming_sourceGone()}
															</p>
														{/if}
													</div>
												</div>
											</div>
										</div>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
					{#if totalPages > 1}
						<tfoot
							><tr
								><td colspan="6" class="border-t border-base-content/8 py-2">
									<div class="flex items-center justify-center gap-2">
										<button
											class="btn btn-ghost btn-xs"
											disabled={currentPage <= 1}
											onclick={() => loadRecords('renaming-failures', currentPage - 1)}
											>{m.reports_pagination_prev()}</button
										>
										<span class="text-xs text-base-content/60">{currentPage} / {totalPages}</span>
										<button
											class="btn btn-ghost btn-xs"
											disabled={currentPage >= totalPages}
											onclick={() => loadRecords('renaming-failures', currentPage + 1)}
											>{m.reports_pagination_next()}</button
										>
									</div>
								</td></tr
							></tfoot
						>
					{/if}
				</table>
			</div>
		{/if}
	{:else}
		{#if loading}
			<div class="flex items-center justify-center py-16">
				<Loader2 class="h-5 w-5 animate-spin text-base-content/40" />
				<span class="ml-2 text-sm text-base-content/60">{m.reports_loading()}</span>
			</div>
		{:else if records.length === 0}
			<div class="flex flex-col items-center justify-center py-20 text-center">
				<AlertTriangle class="mb-3 h-12 w-12 text-base-content/15" />
				<p class="font-medium text-base-content/60">{m.reports_empty()}</p>
				<p class="mt-1 text-sm text-base-content/40">{m.reports_emptyDescription()}</p>
			</div>
		{:else}
			<div class="flex items-center justify-between">
				<p class="text-sm text-base-content/60">{m.reports_totalRecords({ count: total })}</p>
				<button class="btn btn-ghost btn-sm" onclick={() => loadRecords(activeTab, currentPage)}>
					<RefreshCw class="h-4 w-4" />
				</button>
			</div>

			<div class="overflow-x-auto rounded-lg border border-base-content/12 bg-base-100 shadow-sm">
				<table class="table w-full table-sm">
					<thead>
						<tr
							class="border-b border-base-content/10 bg-base-200 text-[11px] font-semibold tracking-widest text-base-content/50 uppercase"
						>
							{#if activeTab === 'rejected-releases'}
								<th>{m.reports_col_release()}</th><th>{m.reports_col_indexer()}</th><th
									>{m.reports_col_protocol()}</th
								><th>{m.reports_col_reason()}</th><th>{m.reports_col_date()}</th><th
									>{m.reports_col_status()}</th
								><th></th>
							{:else if activeTab === 'import-failures'}
								<th>{m.reports_col_release()}</th><th>{m.reports_col_stage()}</th><th
									>{m.reports_col_reason()}</th
								><th>{m.reports_col_date()}</th><th>{m.reports_col_status()}</th><th></th>
							{:else if activeTab === 'renaming-failures'}
								<th>{m.reports_col_file()}</th><th>{m.reports_col_reason()}</th><th
									>{m.reports_col_date()}</th
								><th>{m.reports_col_status()}</th><th></th>
							{/if}
						</tr>
					</thead>
					<tbody class="divide-y divide-base-content/8">
						{#each records as record (record.id)}
							{@const expanded = expandedId === record.id}
							<tr
								class="hover cursor-pointer"
								onclick={() => (expandedId = expanded ? null : record.id)}
							>
								{#if activeTab === 'rejected-releases'}
									<td
										><div class="flex items-center gap-1.5">
											<ChevronRight
												class="h-3 w-3 shrink-0 text-base-content/30 transition-transform {expanded
													? 'rotate-90'
													: ''}"
											/><span class="max-w-xs truncate font-medium"
												>{record.releaseTitle ?? '-'}</span
											>
										</div></td
									>
									<td class="text-base-content/70">{record.indexerName ?? '-'}</td>
									<td
										>{#if record.protocol}<span class="badge badge-ghost badge-sm uppercase"
												>{record.protocol}</span
											>{:else}-{/if}</td
									>
									<td class="max-w-xs text-sm"
										><span class="line-clamp-2"
											>{Array.isArray(record.rejectionReasons)
												? record.rejectionReasons[0]
												: '-'}</span
										></td
									>
									<td class="text-sm whitespace-nowrap text-base-content/60"
										>{formatDate(String(record.rejectedAt ?? ''))}</td
									>
									<td
										><span class="badge badge-sm {statusBadgeClass(String(record.status ?? ''))}"
											>{statusLabel(String(record.status ?? ''))}</span
										></td
									>
									<td onclick={(e) => e.stopPropagation()}
										>{#if record.status !== 'overridden'}<button
												class="btn btn-ghost btn-xs"
												onclick={() => resolveRecord(record.id)}>{m.reports_resolve()}</button
											>{/if}</td
									>
								{:else if activeTab === 'import-failures'}
									<td
										><div class="flex items-center gap-1.5">
											<ChevronRight
												class="h-3 w-3 shrink-0 text-base-content/30 transition-transform {expanded
													? 'rotate-90'
													: ''}"
											/><span class="max-w-xs truncate font-medium"
												>{record.releaseTitle ?? '-'}</span
											>
										</div></td
									>
									<td class="text-sm">{stageLabel(String(record.failureStage ?? ''))}</td>
									<td class="max-w-xs text-sm text-base-content/70"
										><span class="line-clamp-1">{record.reasonDetail ?? record.reason ?? '-'}</span
										></td
									>
									<td class="text-sm whitespace-nowrap text-base-content/60"
										>{formatDate(String(record.failedAt ?? ''))}</td
									>
									<td
										><span class="badge badge-sm {statusBadgeClass(String(record.status ?? ''))}"
											>{statusLabel(String(record.status ?? ''))}</span
										></td
									>
									<td onclick={(e) => e.stopPropagation()}
										>{#if record.status !== 'resolved'}<button
												class="btn btn-ghost btn-xs"
												onclick={() => resolveRecord(record.id)}>{m.reports_resolve()}</button
											>{/if}</td
									>
								{:else if activeTab === 'renaming-failures'}
									<td
										><div class="flex items-center gap-1.5">
											<ChevronRight
												class="h-3 w-3 shrink-0 text-base-content/30 transition-transform {expanded
													? 'rotate-90'
													: ''}"
											/><span class="max-w-xs truncate font-medium"
												>{String(record.sourcePath ?? '')
													.split('/')
													.pop() || '-'}</span
											>
										</div></td
									>
									<td class="text-sm">{record.reason ?? '-'}</td>
									<td class="text-sm whitespace-nowrap text-base-content/60"
										>{formatDate(String(record.failedAt ?? ''))}</td
									>
									<td
										><span class="badge badge-sm {statusBadgeClass(String(record.status ?? ''))}"
											>{statusLabel(String(record.status ?? ''))}</span
										></td
									>
									<td onclick={(e) => e.stopPropagation()}
										>{#if record.status !== 'resolved'}<button
												class="btn btn-ghost btn-xs"
												onclick={() => resolveRecord(record.id)}>{m.reports_resolve()}</button
											>{/if}</td
									>
								{/if}
							</tr>

							{#if expanded}
								<tr>
									<td colspan="7" class="p-0">
										<div
											class="space-y-2 border-l-4 border-l-primary bg-base-200 py-4 pr-6 pl-10 text-sm"
										>
											{#if activeTab === 'rejected-releases'}
												{#if record.mediaTitle}<div class="flex gap-2">
														<span class="w-24 shrink-0 text-base-content/50"
															>{m.reports_detail_media()}</span
														><span
															>{record.mediaTitle}
															{record.mediaType ? `(${record.mediaType})` : ''}</span
														>
													</div>{/if}
												{#if record.releaseSize}<div class="flex gap-2">
														<span class="w-24 shrink-0 text-base-content/50"
															>{m.reports_detail_size()}</span
														><span>{formatBytes(Number(record.releaseSize))}</span>
													</div>{/if}
												{#if record.qualityProfileName}<div class="flex gap-2">
														<span class="w-24 shrink-0 text-base-content/50"
															>{m.reports_detail_profile()}</span
														><span>{record.qualityProfileName}</span>
													</div>{/if}
												{#if Array.isArray(record.rejectionReasons) && record.rejectionReasons.length > 0}
													<div class="flex gap-2">
														<span class="w-24 shrink-0 text-base-content/50"
															>{m.reports_detail_reasons()}</span
														>
														<ul class="list-disc space-y-0.5 pl-4">
															{#each record.rejectionReasons as r (r)}<li>{r}</li>{/each}
														</ul>
													</div>
												{/if}
												{#if record.correlationId}<div class="flex gap-2">
														<span class="w-24 shrink-0 text-base-content/50"
															>{m.reports_detail_trace()}</span
														><a
															href="/settings/monitoring/logs?correlationId={record.correlationId}"
															class="link font-mono text-xs link-primary"
															onclick={(e) => e.stopPropagation()}>{m.reports_viewTrace()} ↗</a
														>
													</div>{/if}
											{:else if activeTab === 'import-failures'}
												{#if record.sourcePath}<div class="flex gap-2">
														<span class="w-24 shrink-0 text-base-content/50"
															>{m.reports_detail_source()}</span
														><span class="font-mono text-xs break-all">{record.sourcePath}</span>
													</div>{/if}
												{#if record.destinationPath}<div class="flex gap-2">
														<span class="w-24 shrink-0 text-base-content/50"
															>{m.reports_detail_destination()}</span
														><span class="font-mono text-xs break-all"
															>{record.destinationPath}</span
														>
													</div>{/if}
												{#if record.reasonDetail}<div class="flex gap-2">
														<span class="w-24 shrink-0 text-base-content/50"
															>{m.reports_detail_error()}</span
														><span class="text-error">{record.reasonDetail}</span>
													</div>{/if}
												{#if Array.isArray(record.dangerousFiles) && record.dangerousFiles.length > 0}<div
														class="flex gap-2"
													>
														<span class="w-24 shrink-0 text-base-content/50"
															>{m.reports_detail_dangerous()}</span
														>
														<ul class="list-disc pl-4 font-mono text-xs">
															{#each record.dangerousFiles as f (f)}<li>
																	{f.path} ({f.extension})
																</li>{/each}
														</ul>
													</div>{/if}
												<div class="flex gap-2">
													<span class="w-24 shrink-0 text-base-content/50"
														>{m.reports_detail_attempts()}</span
													><span>{record.attemptCount ?? 1}</span>
												</div>
												{#if record.correlationId}<div class="flex gap-2">
														<span class="w-24 shrink-0 text-base-content/50"
															>{m.reports_detail_trace()}</span
														><a
															href="/settings/monitoring/logs?correlationId={record.correlationId}"
															class="link font-mono text-xs link-primary"
															onclick={(e) => e.stopPropagation()}>{m.reports_viewTrace()} ↗</a
														>
													</div>{/if}
											{:else if activeTab === 'renaming-failures'}
												<div class="flex gap-2">
													<span class="w-24 shrink-0 text-base-content/50"
														>{m.reports_detail_source()}</span
													><span class="font-mono text-xs break-all">{record.sourcePath}</span>
												</div>
												<div class="flex gap-2">
													<span class="w-24 shrink-0 text-base-content/50"
														>{m.reports_detail_intended()}</span
													><span class="font-mono text-xs break-all">{record.intendedPath}</span>
												</div>
												{#if record.namingTemplate}<div class="flex gap-2">
														<span class="w-24 shrink-0 text-base-content/50"
															>{m.reports_detail_template()}</span
														><span class="font-mono text-xs">{record.namingTemplate}</span>
													</div>{/if}
												{#if record.reasonDetail}<div class="flex gap-2">
														<span class="w-24 shrink-0 text-base-content/50"
															>{m.reports_detail_error()}</span
														><span class="text-error">{record.reasonDetail}</span>
													</div>{/if}
											{/if}
											{#if record.correlationId}<div class="flex gap-2">
													<span class="w-24 shrink-0 text-base-content/50"
														>{m.reports_detail_trace()}</span
													><a
														href="/settings/monitoring/logs?correlationId={record.correlationId}"
														class="link font-mono text-xs link-primary"
														onclick={(e) => e.stopPropagation()}>{m.reports_viewTrace()} ↗</a
													>
												</div>{/if}
										</div>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
					{#if totalPages > 1}
						<tfoot>
							<tr>
								<td colspan="7" class="border-t border-base-content/8 py-2">
									<div class="flex items-center justify-center gap-2">
										<button
											class="btn btn-ghost btn-xs"
											disabled={currentPage <= 1}
											onclick={() => loadRecords(activeTab, currentPage - 1)}
											>{m.reports_pagination_prev()}</button
										>
										<span class="text-xs text-base-content/60">{currentPage} / {totalPages}</span>
										<button
											class="btn btn-ghost btn-xs"
											disabled={currentPage >= totalPages}
											onclick={() => loadRecords(activeTab, currentPage + 1)}
											>{m.reports_pagination_next()}</button
										>
									</div>
								</td>
							</tr>
						</tfoot>
					{/if}
				</table>
			</div>
		{/if}
	{/if}
</div>

<ConfirmationModal
	open={confirmResolveAllOpen}
	title={m.reports_confirmResolveAllTitle()}
	message={m.reports_confirmResolveAllMessage({ count: total })}
	confirmLabel={m.reports_resolveAll({ count: total })}
	confirmVariant="error"
	loading={resolvingAll}
	onConfirm={confirmResolveAll}
	onCancel={() => (confirmResolveAllOpen = false)}
/>
