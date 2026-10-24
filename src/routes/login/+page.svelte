<script lang="ts">
	import { goto } from '$app/navigation';
	import { User, Lock, AlertCircle, Eye, EyeOff } from '@lucide/svelte';
	import { authClient } from '#lib/auth/client.js';
	import { ensureVersionPrefix } from '#lib/version.js';
	import * as m from '#lib/paraglide/messages.js';

	const GITHUB_URL = 'https://github.com/cinephage/cinephage';
	const DISCORD_URL = 'https://discord.gg/scGCBTSWEt';

	let { data } = $props();

	let username = $state('');
	let password = $state('');
	let rememberMe = $state(false);
	let isLoading = $state(false);
	let error = $state('');
	let showPassword = $state(false);

	async function handleSubmit() {
		error = '';
		isLoading = true;

		try {
			const result = await authClient.signIn.username({
				username: username.toLowerCase(),
				password,
				rememberMe
			});

			if (result.error) {
				// A 429 here is the rate limiter (5 attempts / 15 min), not a bad
				// password, surfacing it as "Invalid username or password" hides
				// the actual cause and reads as if the correct password just
				// stopped working (GitHub issue #596).
				error =
					result.error.status === 429
						? m.login_rateLimited()
						: result.error.message || m.login_invalidCredentials();
				return;
			}

			// Refresh all server load data (root layout now carries user
			// identity) before entering the app.
			await goto('/', { refreshAll: true });
		} catch (e) {
			error = e instanceof Error ? e.message : m.login_unexpectedError();
		} finally {
			isLoading = false;
		}
	}
</script>

<svelte:head>
	<title>{m.login_pageTitle()}</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-base-200 p-4">
	<div class="card w-full max-w-md bg-base-100 shadow-xl">
		<div class="card-body">
			<div class="mb-6 space-y-2 text-center">
				<img src="/logo.png" alt="Cinephage" class="mx-auto h-20 w-20 rounded-2xl object-contain" />
				<h1 class="text-3xl font-bold">{m.login_welcomeBack()}</h1>
				<p class="text-base-content/70">{m.login_subtitle()}</p>
			</div>

			{#if error}
				<div class="mb-4 alert alert-error">
					<AlertCircle class="h-5 w-5" />
					<span>{error}</span>
				</div>
			{/if}

			<form
				onsubmit={(e) => {
					e.preventDefault();
					handleSubmit();
				}}
				class="space-y-4"
			>
				<!-- Username -->
				<div class="form-control">
					<label class="label">
						<span class="label-text flex items-center gap-2">
							<User class="h-4 w-4" />
							{m.login_usernameLabel()}
						</span>
					</label>
					<input
						type="text"
						class="input-bordered input w-full"
						placeholder={m.login_usernamePlaceholder()}
						bind:value={username}
						required
						autocomplete="username"
					/>
				</div>

				<!-- Password -->
				<div class="form-control">
					<label class="label">
						<span class="label-text flex items-center gap-2">
							<Lock class="h-4 w-4" />
							{m.login_passwordLabel()}
						</span>
					</label>
					<div class="relative">
						<input
							type={showPassword ? 'text' : 'password'}
							class="input-bordered input w-full pr-12"
							placeholder="••••••••"
							bind:value={password}
							required
							autocomplete="current-password"
						/>
						<button
							type="button"
							class="btn absolute top-1/2 right-2 -translate-y-1/2 btn-ghost btn-sm"
							aria-label={showPassword ? 'Hide password' : 'Show password'}
							aria-pressed={showPassword}
							onclick={() => (showPassword = !showPassword)}
						>
							{#if showPassword}
								<EyeOff class="h-4 w-4" />
							{:else}
								<Eye class="h-4 w-4" />
							{/if}
						</button>
					</div>
				</div>

				<!-- Remember Me -->
				<div class="form-control">
					<label class="label cursor-pointer justify-start gap-2">
						<input type="checkbox" class="checkbox checkbox-primary" bind:checked={rememberMe} />
						<span class="label-text">{m.login_rememberMe()}</span>
					</label>
				</div>

				<button
					type="submit"
					class="btn w-full btn-primary"
					disabled={isLoading || !username || !password}
				>
					{#if isLoading}
						<span class="loading loading-spinner">&#8203;</span>
						{m.action_signingIn()}
					{:else}
						{m.action_signIn()}
					{/if}
				</button>
			</form>

			<div class="mt-6 flex items-center justify-center gap-4 text-xs text-base-content/40">
				<span>{ensureVersionPrefix(data.version)}</span>
				<a
					href={DISCORD_URL}
					target="_blank"
					rel="noopener noreferrer"
					class="flex items-center gap-1 transition-colors hover:text-base-content/70"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-3.5 w-3.5"
						viewBox="0 0 24 24"
						fill="currentColor"
					>
						<path
							d="M20.317 4.492c-1.53-.69-3.17-1.2-4.885-1.49a.075.075 0 0 0-.079.036c-.21.369-.444.85-.608 1.23a18.566 18.566 0 0 0-5.487 0 12.36 12.36 0 0 0-.617-1.23A.077.077 0 0 0 8.562 3c-1.714.29-3.354.8-4.885 1.491a.07.07 0 0 0-.032.027C.533 9.093-.32 13.555.099 17.961a.08.08 0 0 0 .031.055 20.03 20.03 0 0 0 5.993 2.98.078.078 0 0 0 .084-.026 13.83 13.83 0 0 0 1.226-1.963.074.074 0 0 0-.041-.104 13.175 13.175 0 0 1-1.872-.878.075.075 0 0 1-.008-.125c.126-.093.252-.19.372-.287a.075.075 0 0 1 .078-.01c3.927 1.764 8.18 1.764 12.061 0a.075.075 0 0 1 .079.009c.12.098.245.195.372.288a.075.075 0 0 1-.006.125c-.598.344-1.22.635-1.873.877a.075.075 0 0 0-.041.105c.36.687.772 1.341 1.225 1.962a.077.077 0 0 0 .084.028 19.963 19.963 0 0 0 6.002-2.981.076.076 0 0 0 .032-.054c.5-5.094-.838-9.52-3.549-13.442a.06.06 0 0 0-.031-.028z"
						/>
						<ellipse cx="8.5" cy="12.5" rx="1.5" ry="1.65" fill="var(--discord-eye, white)" />
						<ellipse cx="15.5" cy="12.5" rx="1.5" ry="1.65" fill="var(--discord-eye, white)" />
					</svg>
					Discord
				</a>
				<a
					href={GITHUB_URL}
					target="_blank"
					rel="noopener noreferrer"
					class="flex items-center gap-1 transition-colors hover:text-base-content/70"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-3.5 w-3.5"
						viewBox="0 0 24 24"
						fill="currentColor"
					>
						<path
							d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"
						/>
					</svg>
					GitHub
				</a>
			</div>
		</div>
	</div>
</div>
