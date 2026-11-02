(function () {
	// Storage access throws in browsers that block site data
	// (e.g. Firefox ETP / blocked cookies) — fall back to system theme.
	// Precedence: the account-preference cookie (seeded server-side so
	// a theme follows the account across devices) beats this device's
	// localStorage, then the system preference.
	//
	// Loaded as a blocking script from <head> so it runs before first paint;
	// it must stay inline-free because the CSP allows no inline scripts.
	let theme = null;
	try {
		var match = document.cookie.match(/(?:^|;\s*)cinephage-theme=([^;]+)/);
		theme = match ? decodeURIComponent(match[1]) : null;
	} catch {
		// Cookies blocked — fall through to localStorage below.
	}
	if (!theme) {
		try {
			theme = localStorage.getItem('theme');
		} catch {
			// Storage blocked — fall through to the system preference.
		}
	}
	const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	document.documentElement.setAttribute('data-theme', theme || systemTheme);
})();
