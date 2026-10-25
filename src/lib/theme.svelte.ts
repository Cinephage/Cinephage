import { browser } from '$app/env';
import type { Theme } from './themes';

const THEME_KEY = 'theme';

class ThemeStore {
	current = $state<Theme>('dark');

	constructor() {
		if (browser) {
			let stored: Theme | null = null;
			try {
				stored = localStorage.getItem(THEME_KEY) as Theme | null;
			} catch {
				// Storage blocked (e.g. Firefox ETP / blocked cookies) — use system theme.
			}
			if (stored) {
				this.current = stored;
				this.apply(stored);
			} else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
				this.current = 'dark';
				this.apply('dark');
			} else {
				this.current = 'light';
				this.apply('light');
			}
		}
	}

	set(theme: Theme) {
		this.current = theme;
		this.apply(theme);
		if (browser) {
			try {
				localStorage.setItem(THEME_KEY, theme);
			} catch {
				// Storage blocked — theme still applies for this session.
			}
		}
	}

	private apply(theme: Theme) {
		if (browser) {
			document.documentElement.setAttribute('data-theme', theme);
		}
	}
}

export const theme = new ThemeStore();
