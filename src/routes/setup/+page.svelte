<script lang="ts">
	import { goto } from '$app/navigation';
	import { User, Lock, CheckCircle, AlertCircle } from '@lucide/svelte';
	import { authClient } from '#lib/auth/client.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { ensureVersionPrefix } from '#lib/version.js';

	const GITHUB_URL = 'https://github.com/cinephage/cinephage';
	const DISCORD_URL = 'https://discord.gg/scGCBTSWEt';

	let { data } = $props();
	import { createApiKeys } from '#lib/api/index.js';
	import {
		isHardReservedUsername,
		USERNAME_MAX_LENGTH,
		USERNAME_MIN_LENGTH,
		USERNAME_PATTERN
	} from '#lib/auth/username-policy.js';
	import * as m from '#lib/paraglide/messages.js';

	let currentStep = $state(1);
	let isLoading = $state(false);
	let error = $state('');

	// Form data
	let username = $state('');
	let email = $state('');
	let password = $state('');
	let confirmPassword = $state('');

	// Validation states
	let usernameError = $state('');
	let emailError = $state('');
	let passwordErrors = $state({
		length: false,
		uppercase: false,
		lowercase: false,
		number: false,
		special: false
	});
	let confirmError = $state('');

	function validateUsername(): boolean {
		usernameError = '';

		if (username.length < USERNAME_MIN_LENGTH) {
			usernameError = m.setup_usernameMinLength({ min: String(USERNAME_MIN_LENGTH) });
			return false;
		}
		if (username.length > USERNAME_MAX_LENGTH) {
			usernameError = m.setup_usernameMaxLength({ max: String(USERNAME_MAX_LENGTH) });
			return false;
		}
		if (!USERNAME_PATTERN.test(username)) {
			usernameError = m.setup_usernameInvalidChars();
			return false;
		}
		if (isHardReservedUsername(username)) {
			usernameError = m.setup_usernameReserved();
			return false;
		}

		return true;
	}

	function validateEmail(): boolean {
		if (!email || email.length === 0) {
			emailError = m.setup_emailRequired();
			return false;
		}
		// Basic email validation
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!emailRegex.test(email)) {
			emailError = m.setup_emailInvalid();
			return false;
		}
		emailError = '';
		return true;
	}

	function validatePassword(): boolean {
		const errors = {
			length: password.length >= 8,
			uppercase: /[A-Z]/.test(password),
			lowercase: /[a-z]/.test(password),
			number: /[0-9]/.test(password),
			special: /[^A-Za-z0-9\s]/.test(password)
		};
		passwordErrors = errors;

		// Calculate strength
		const passed = Object.values(errors).filter(Boolean).length;

		return passed === 5;
	}

	function validateConfirm(): boolean {
		if (password !== confirmPassword) {
			confirmError = m.setup_passwordsDoNotMatch();
			return false;
		}
		confirmError = '';
		return true;
	}

	async function handleSubmit() {
		error = '';

		if (!validateUsername() || !validateEmail() || !validatePassword() || !validateConfirm()) {
			return;
		}

		isLoading = true;

		try {
			// Better Auth username plugin uses signUp.email endpoint with username field
			const result = await authClient.signUp.email({
				email: email,
				password,
				name: username, // Display name
				username: username.toLowerCase() // Actual username field
			});

			if (result.error) {
				error = result.error.message || m.setup_failedToCreateAccount();
				return;
			}

			// Create API keys for the new user
			try {
				await createApiKeys();
			} catch (apiKeyError) {
				// Don't fail setup if API key creation fails - keys can be regenerated later
				toasts.warning(m.setup_apiKeyFailed(), {
					description: apiKeyError instanceof Error ? apiKeyError.message : m.setup_apiKeyLater()
				});
			}

			// Mark setup as complete
			currentStep = 3;

			// Redirect to dashboard after 2 seconds
			setTimeout(() => {
				goto('/');
			}, 2000);
		} catch (e) {
			error = e instanceof Error ? e.message : m.login_unexpectedError();
		} finally {
			isLoading = false;
		}
	}
</script>

<svelte:head>
	<title>{m.setup_pageTitle()}</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-base-200 p-4">
	<div class="card w-full max-w-lg bg-base-100 shadow-xl">
		<div class="card-body">
			<div class="mb-2 text-center">
				<img src="/logo.png" alt="Cinephage" class="mx-auto h-20 w-20 rounded-2xl object-contain" />
			</div>

			{#if currentStep === 1}
				<!-- Step 1: Welcome -->
				<div class="space-y-4 text-center">
					<h1 class="text-3xl font-bold">{m.setup_welcomeTitle()}</h1>
					<p class="text-base-content/70">{m.setup_welcomeSubtitle()}</p>
					<div class="pt-4">
						<button
							class="btn btn-wide btn-primary"
							onclick={() => (currentStep = 2)}
							disabled={isLoading}
						>
							{m.setup_getStarted()}
						</button>
					</div>
				</div>
			{:else if currentStep === 2}
				<!-- Step 2: Create Admin Account -->
				<div class="space-y-6">
					<div class="text-center">
						<h2 class="text-2xl font-bold">{m.setup_createAdminTitle()}</h2>
						<p class="text-sm text-base-content/70">
							{m.setup_createAdminSubtitle()}
						</p>
					</div>

					{#if error}
						<div class="alert alert-error">
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
							<label class="label" for="setup-username">
								<span class="label-text flex items-center gap-2">
									<User class="h-4 w-4" />
									{m.setup_usernameLabel()}
								</span>
							</label>
							<input
								id="setup-username"
								type="text"
								class="input-bordered input w-full"
								class:input-error={usernameError}
								placeholder={m.setup_usernamePlaceholder()}
								bind:value={username}
								oninput={validateUsername}
								minlength={USERNAME_MIN_LENGTH}
								maxlength={USERNAME_MAX_LENGTH}
								aria-invalid={Boolean(usernameError)}
								aria-describedby="setup-username-help"
								required
							/>
							{#if usernameError}
								<div class="label">
									<span id="setup-username-help" class="label-text-alt text-error"
										>{usernameError}</span
									>
								</div>
							{:else}
								<div class="label">
									<span id="setup-username-help" class="label-text-alt"
										>{m.setup_usernameHelp()}</span
									>
								</div>
							{/if}
						</div>

						<!-- Email -->
						<div class="form-control">
							<label class="label" for="setup-email">
								<span class="label-text flex items-center gap-2">
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="16"
										height="16"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										><rect width="20" height="16" x="2" y="4" rx="2" /><path
											d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"
										/></svg
									>
									{m.setup_emailLabel()}
								</span>
							</label>
							<input
								id="setup-email"
								type="email"
								class="input-bordered input w-full"
								class:input-error={emailError}
								placeholder={m.setup_emailPlaceholder()}
								bind:value={email}
								oninput={validateEmail}
								aria-invalid={Boolean(emailError)}
								aria-describedby={emailError ? 'setup-email-help' : undefined}
								required
							/>
							{#if emailError}
								<div class="label">
									<span id="setup-email-help" class="label-text-alt text-error">{emailError}</span>
								</div>
							{/if}
						</div>

						<!-- Password -->
						<div class="form-control">
							<label class="label" for="setup-password">
								<span class="label-text flex items-center gap-2">
									<Lock class="h-4 w-4" />
									{m.setup_passwordLabel()}
								</span>
							</label>
							<input
								id="setup-password"
								type="password"
								class="input-bordered input w-full"
								placeholder="••••••••"
								bind:value={password}
								oninput={validatePassword}
								minlength="8"
								required
							/>

							<!-- Password requirements -->
							<div class="mt-2 space-y-1 text-xs">
								<div class={passwordErrors.length ? 'text-success' : 'text-base-content/50'}>
									{passwordErrors.length ? '✓' : '○'}
									{m.setup_passwordReqLength()}
								</div>
								<div class={passwordErrors.uppercase ? 'text-success' : 'text-base-content/50'}>
									{passwordErrors.uppercase ? '✓' : '○'}
									{m.setup_passwordReqUppercase()}
								</div>
								<div class={passwordErrors.lowercase ? 'text-success' : 'text-base-content/50'}>
									{passwordErrors.lowercase ? '✓' : '○'}
									{m.setup_passwordReqLowercase()}
								</div>
								<div class={passwordErrors.number ? 'text-success' : 'text-base-content/50'}>
									{passwordErrors.number ? '✓' : '○'}
									{m.setup_passwordReqNumber()}
								</div>
								<div class={passwordErrors.special ? 'text-success' : 'text-base-content/50'}>
									{passwordErrors.special ? '✓' : '○'}
									{m.setup_passwordReqSpecial()}
								</div>
							</div>
						</div>

						<!-- Confirm Password -->
						<div class="form-control">
							<label class="label" for="setup-confirm-password">
								<span class="label-text">{m.setup_confirmPasswordLabel()}</span>
							</label>
							<input
								id="setup-confirm-password"
								type="password"
								class="input-bordered input w-full"
								class:input-error={confirmError}
								placeholder="••••••••"
								bind:value={confirmPassword}
								oninput={validateConfirm}
								minlength="8"
								aria-invalid={Boolean(confirmError)}
								aria-describedby={confirmError ? 'setup-confirm-password-help' : undefined}
								required
							/>
							{#if confirmError}
								<div class="label">
									<span id="setup-confirm-password-help" class="label-text-alt text-error"
										>{confirmError}</span
									>
								</div>
							{/if}
						</div>

						<div class="flex gap-3 pt-2">
							<button
								type="button"
								class="btn flex-1 btn-ghost"
								onclick={() => (currentStep = 1)}
								disabled={isLoading}
							>
								{m.action_back()}
							</button>
							<button
								type="submit"
								class="btn flex-1 btn-primary"
								disabled={isLoading || !username || !email || !password || !confirmPassword}
							>
								{#if isLoading}
									<span class="loading loading-spinner"></span>
								{/if}
								{m.setup_createAccount()}
							</button>
						</div>
					</form>
				</div>
			{:else if currentStep === 3}
				<!-- Step 3: Success -->
				<div class="space-y-4 text-center">
					<div class="inline-flex h-16 w-16 items-center justify-center rounded-full bg-success/10">
						<CheckCircle class="h-8 w-8 text-success" />
					</div>
					<h2 class="text-3xl font-bold">{m.setup_completeTitle()}</h2>
					<p class="text-base-content/70">{m.setup_completeMessage()}</p>
					<p class="text-sm text-base-content/50">{m.setup_redirecting()}</p>
					<div class="mt-4 h-2 w-full rounded-full bg-base-200">
						<div class="h-2 w-full animate-pulse rounded-full bg-success"></div>
					</div>
				</div>
			{/if}

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
