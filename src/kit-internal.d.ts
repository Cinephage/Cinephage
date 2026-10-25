/**
 * Minimal type declaration for the `@sveltejs/kit/internal/server` subpath.
 *
 * The package's type entry (`types/index.d.ts`) is an ambient declaration
 * file that does not declare this subpath as a module, so TypeScript cannot
 * see its exports even though the runtime resolves fine. Declared here so
 * the auth test harness can use `with_request_store` (the sanctioned way to
 * run code inside the request store outside a real SvelteKit server).
 */
declare module '@sveltejs/kit/internal/server' {
	export function with_request_store<T>(store: unknown, fn: () => T): T;
	export function getRequestEvent(): unknown;
	export function try_get_request_store(): { event: unknown } | null;
}
