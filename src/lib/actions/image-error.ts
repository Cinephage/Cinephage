/**
 * Attach an image error handler from JavaScript.
 *
 * Svelte compiles `onerror={...}` to an inline attribute for SSR, and the CSP
 * here refuses inline handlers — so the fallback never ran in the browser.
 * A listener added by an action is not inline and is allowed.
 */
export function imageError(node: HTMLImageElement, onError: () => void) {
	let callback = onError;
	const handler = () => callback();
	node.addEventListener('error', handler);
	return {
		update(next: () => void) {
			callback = next;
		},
		destroy() {
			node.removeEventListener('error', handler);
		}
	};
}
