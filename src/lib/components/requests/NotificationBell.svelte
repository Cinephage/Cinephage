<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		Bell,
		CheckCheck,
		Clock,
		CheckCircle2,
		XCircle,
		TimerOff,
		PackageCheck,
		Inbox
	} from '@lucide/svelte';
	import {
		listNotifications,
		markNotificationsRead,
		type RequestNotification
	} from '#lib/api/requests.js';
	import { formatDisplayDateShort } from '#lib/utils/format.js';

	interface Props {
		/**
		 * Only the header matching the current breakpoint keeps its SSE
		 * stream open; the inert twin renders (CSS-hidden) without one.
		 */
		enabled?: boolean;
	}

	let { enabled = true }: Props = $props();

	let open = $state(false);
	let unread = $state(0);
	let feed = $state<RequestNotification[]>([]);
	let source: EventSource | null = null;

	const UNREAD_PREVIEW_LIMIT = 8;

	const eventVisual = (event: string): { icon: typeof Clock; cls: string } => {
		switch (event) {
			case 'request_pending':
				return { icon: Clock, cls: 'bg-warning/15 text-warning' };
			case 'request_approved':
			case 'request_approved_auto':
				return { icon: CheckCircle2, cls: 'bg-info/15 text-info' };
			case 'request_declined':
				return { icon: XCircle, cls: 'bg-base-content/5 text-base-content/50' };
			case 'request_expired':
				return { icon: TimerOff, cls: 'bg-base-content/5 text-base-content/50' };
			case 'request_failed':
				return { icon: XCircle, cls: 'bg-error/15 text-error' };
			case 'request_fulfilled':
				return { icon: PackageCheck, cls: 'bg-success/15 text-success' };
			default:
				return { icon: Bell, cls: 'bg-base-content/5 text-base-content/50' };
		}
	};

	async function refresh() {
		try {
			const data = await listNotifications({ take: 20 });
			feed = data.notifications ?? [];
			unread = data.unreadCount ?? 0;
		} catch {
			// Feed is non-critical; keep the last known state.
		}
	}

	function eventText(notification: RequestNotification): string {
		switch (notification.event) {
			case 'request_pending':
				return m.requests_notifPending();
			case 'request_approved':
				return m.requests_notifApproved();
			case 'request_approved_auto':
				return m.requests_notifApprovedAuto();
			case 'request_declined':
				return m.requests_notifDeclined();
			case 'request_expired':
				return m.requests_notifExpired();
			case 'request_failed':
				return m.requests_notifFailed();
			case 'request_fulfilled':
				return m.requests_notifFulfilled();
			default:
				return notification.event;
		}
	}

	async function markAll() {
		try {
			await markNotificationsRead();
			await refresh();
		} catch {
			// non-fatal
		}
	}

	async function markOne(notification: RequestNotification) {
		if (notification.readAt) return;
		try {
			await markNotificationsRead([notification.id]);
			await refresh();
		} catch {
			// non-fatal
		}
	}

	function toggle() {
		open = !open;
		if (open) void refresh();
	}

	$effect(() => {
		if (!enabled) return;
		void refresh();
		// The stream carries refresh nudges only, so re-fetch on event.
		const stream = new EventSource('/api/requests/stream');
		source = stream;
		stream.addEventListener('requests:refresh', () => {
			void refresh();
		});
		return () => {
			stream.close();
			if (source === stream) source = null;
		};
	});
</script>

<div class="relative">
	<button
		type="button"
		class="btn btn-ghost btn-sm"
		aria-label={m.requests_notifTitle()}
		onclick={toggle}
	>
		<div class="indicator">
			<Bell class="h-4.5 w-4.5" />
			{#if unread > 0}
				<span
					class="indicator-item badge h-4 min-h-4 border-none bg-error px-1 text-[10px] font-bold text-error-content"
				>
					{unread > 9 ? '9+' : unread}
				</span>
			{/if}
		</div>
	</button>

	{#if open}
		<div
			class="absolute top-11 right-0 z-[60] w-85 overflow-hidden rounded-xl border border-base-content/10 bg-base-100 shadow-xl"
		>
			<div class="flex items-center justify-between border-b border-base-content/10 px-4 py-2.5">
				<span class="text-sm font-semibold">{m.requests_notifTitle()}</span>
				{#if unread > 0}
					<button
						type="button"
						class="btn gap-1 btn-ghost text-base-content/60 btn-xs"
						onclick={markAll}
					>
						<CheckCheck class="h-3.5 w-3.5" />
						{m.requests_notifMarkAllRead()}
					</button>
				{/if}
			</div>

			<div class="max-h-96 overflow-y-auto">
				{#if feed.length === 0}
					<div class="flex flex-col items-center gap-2 py-10 text-center">
						<Inbox class="h-8 w-8 text-base-content/20" />
						<p class="text-sm text-base-content/50">{m.requests_notifEmpty()}</p>
					</div>
				{:else}
					{#each feed.slice(0, UNREAD_PREVIEW_LIMIT * 3) as notification (notification.id)}
						{@const visual = eventVisual(notification.event)}
						{@const Icon = visual.icon}
						<button
							type="button"
							class="flex w-full items-start gap-3 border-b border-base-content/5 px-4 py-2.5 text-left transition-colors last:border-0 hover:bg-base-content/[0.04] {notification.readAt
								? ''
								: 'bg-primary/[0.04]'}"
							onclick={() => markOne(notification)}
						>
							<span
								class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full {visual.cls}"
							>
								<Icon class="h-3.5 w-3.5" />
							</span>
							<span class="min-w-0 flex-1">
								<span class="block truncate text-sm font-medium">
									{String(notification.payload?.title ?? '')}
								</span>
								<span class="block text-xs text-base-content/60">{eventText(notification)}</span>
								{#if notification.payload?.reason}
									<span class="block truncate text-xs text-base-content/40">
										{String(notification.payload.reason)}
									</span>
								{/if}
							</span>
							<span class="shrink-0 pt-0.5 text-xs text-base-content/40">
								{formatDisplayDateShort(notification.createdAt)}
							</span>
						</button>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</div>
