/**
 * Toast notification store using Svelte 5 runes
 *
 * This store is client-side only. Toasts are UI notifications
 * that only make sense in the browser context.
 */

import { browser } from '$app/env';

// Generate unique ID with fallback for environments without crypto.randomUUID
function generateId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	// Fallback: timestamp + random string
	return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
	id: string;
	type: ToastType;
	message: string;
	description?: string;
	duration?: number;
	action?: {
		label: string;
		href?: string;
		onClick?: () => void;
	};
}

interface ToastState {
	toasts: Toast[];
}

function createToastStore() {
	const state = $state<ToastState>({ toasts: [] });

	function add(toast: Omit<Toast, 'id'>): string {
		// Toasts only work in the browser
		if (!browser) {
			return '';
		}

		const id = generateId();
		const newToast: Toast = { ...toast, id };

		state.toasts = [...state.toasts, newToast];

		// Auto-dismiss after duration (default 5 seconds)
		const duration = toast.duration ?? 5000;
		if (duration > 0) {
			setTimeout(() => {
				dismiss(id);
			}, duration);
		}

		return id;
	}

	function dismiss(id: string) {
		state.toasts = state.toasts.filter((t) => t.id !== id);
	}

	function clear() {
		state.toasts = [];
	}

	// Convenience methods
	function success(message: string, options?: Partial<Omit<Toast, 'id' | 'type' | 'message'>>) {
		return add({ type: 'success', message, ...options });
	}

	function error(message: string, options?: Partial<Omit<Toast, 'id' | 'type' | 'message'>>) {
		return add({ type: 'error', message, duration: 8000, ...options });
	}

	function warning(message: string, options?: Partial<Omit<Toast, 'id' | 'type' | 'message'>>) {
		return add({ type: 'warning', message, ...options });
	}

	function info(message: string, options?: Partial<Omit<Toast, 'id' | 'type' | 'message'>>) {
		return add({ type: 'info', message, ...options });
	}

	return {
		get toasts() {
			return state.toasts;
		},
		add,
		dismiss,
		clear,
		success,
		error,
		warning,
		info
	};
}

export const toasts = createToastStore();
