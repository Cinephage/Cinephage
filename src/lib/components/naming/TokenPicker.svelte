<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		Search,
		Copy,
		Plus,
		Sparkles,
		Film,
		Tv,
		Music,
		Video,
		FileText,
		Zap,
		Check
	} from '@lucide/svelte';
	import { copyToClipboard } from '#lib/utils/clipboard.js';
	import { toasts } from '#lib/stores/toast.svelte.js';

	interface Token {
		token: string;
		description: string;
	}

	interface TokenCategory {
		name: string;
		icon: typeof Film;
		tokens: Token[];
	}

	interface Props {
		tokens: Record<string, Token[]>;
		activeFieldId?: string;
		context?: 'movie' | 'series' | 'general';
		onInsert?: (token: string) => void;
	}

	let { tokens, activeFieldId, context = 'general', onInsert }: Props = $props();

	let searchQuery = $state('');
	let selectedCategory = $state('recommended');
	let copiedToken = $state<string | null>(null);
	const canInsert = $derived(Boolean(activeFieldId));

	const categoryIcons: Record<string, typeof Film> = {
		movie: Film,
		series: Tv,
		episode: Tv,
		quality: Video,
		video: Video,
		audio: Music,
		release: FileText,
		conditional: Zap
	};

	const categoryOrder = [
		'movie',
		'collection',
		'series',
		'episode',
		'quality',
		'video',
		'audio',
		'release',
		'conditional'
	];

	const conditionalSnippets = [
		{
			pattern: '{[{Token}]}',
			example: '{[{HDR}]}',
			description: m.naming_tokenIncludeBrackets()
		},
		{
			pattern: '{prefix{Token}suffix}',
			example: '{ -{ReleaseGroup}}',
			description: m.naming_tokenIncludePrefixSuffix()
		},
		{
			pattern: '{edition-{Edition}}',
			example: 'edition-Directors Cut',
			description: m.naming_tokenConditionalEdition()
		}
	];

	// Process tokens into categories with icons
	const tokenCategories: TokenCategory[] = $derived(
		categoryOrder
			.filter((cat) => tokens[cat])
			.map((cat) => ({
				name: cat,
				icon: categoryIcons[cat] || FileText,
				tokens: tokens[cat]
			}))
	);

	// Filter tokens based on search
	function getFilteredCategories(): TokenCategory[] {
		if (!searchQuery.trim()) return tokenCategories;

		const query = searchQuery.toLowerCase();
		return tokenCategories
			.map((cat) => ({
				...cat,
				tokens: cat.tokens.filter(
					(t) =>
						t.token.toLowerCase().includes(query) || t.description.toLowerCase().includes(query)
				)
			}))
			.filter((cat) => cat.tokens.length > 0);
	}

	// Get recommended tokens based on context
	function getRecommendedTokens(): Token[] {
		if (context === 'movie') {
			return [
				...(tokens.movie || []),
				...(tokens.quality || []),
				...(tokens.video || []),
				...(tokens.audio || [])
			];
		}
		if (context === 'series') {
			return [
				...(tokens.series || []),
				...(tokens.episode || []),
				...(tokens.quality || []),
				...(tokens.video || [])
			];
		}
		return Object.values(tokens).flat();
	}

	function handleInsert(token: string) {
		if (onInsert) {
			onInsert(token);
		}
	}

	async function handleCopy(token: string) {
		const success = await copyToClipboard(token);
		if (success) {
			copiedToken = token;
			toasts.success(m.naming_tokenCopied({ token }));
			setTimeout(() => (copiedToken = null), 1500);
		} else {
			toasts.error(m.naming_tokenCopyFailed());
		}
	}

	function getCategoryLabel(name: string): string {
		const labels: Record<string, string> = {
			movie: m.naming_tokenCategoryMovie(),
			series: m.naming_tokenCategorySeries(),
			episode: m.naming_tokenCategoryEpisode(),
			quality: m.naming_tokenCategoryQuality(),
			video: m.naming_tokenCategoryVideo(),
			audio: m.naming_tokenCategoryAudio(),
			release: m.naming_tokenCategoryRelease(),
			conditional: m.naming_tokenCategoryConditional()
		};
		return labels[name] || name.charAt(0).toUpperCase() + name.slice(1);
	}

	function getInsertTitle(label: string) {
		return canInsert ? m.naming_tokenInsert({ token: label }) : m.naming_tokenSelectFieldFirst();
	}
</script>

<div class="space-y-4">
	<!-- Search -->
	<div class="form-control relative">
		<Search
			class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/40"
		/>
		<input
			type="text"
			placeholder={m.naming_tokenSearchPlaceholder()}
			class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-8 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
			bind:value={searchQuery}
		/>
		{#if searchQuery}
			<button
				type="button"
				class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-base-content/40 hover:text-base-content"
				onclick={() => (searchQuery = '')}
				aria-label="Clear search"
			>
				×
			</button>
		{/if}
	</div>

	<!-- Category Tabs -->
	{#if !searchQuery}
		<div class="flex flex-wrap gap-1" aria-label="Token categories">
			<button
				type="button"
				class="badge cursor-pointer gap-1 badge-sm"
				class:badge-primary={selectedCategory === 'recommended'}
				class:badge-ghost={selectedCategory !== 'recommended'}
				onclick={() => (selectedCategory = 'recommended')}
			>
				<Sparkles class="h-3 w-3" />
				{m.naming_tokenRecommended()}
			</button>

			{#each tokenCategories as category (category.name)}
				<button
					type="button"
					class="badge cursor-pointer gap-1 badge-sm"
					class:badge-primary={selectedCategory === category.name}
					class:badge-ghost={selectedCategory !== category.name}
					onclick={() => (selectedCategory = category.name)}
				>
					<category.icon class="h-3 w-3" />
					{getCategoryLabel(category.name)}
				</button>
			{/each}

			<button
				type="button"
				class="badge cursor-pointer gap-1 badge-sm"
				class:badge-primary={selectedCategory === 'conditional'}
				class:badge-ghost={selectedCategory !== 'conditional'}
				onclick={() => (selectedCategory = 'conditional')}
			>
				<Zap class="h-3 w-3" />
				{m.naming_tokenPatterns()}
			</button>
		</div>
	{/if}

	<!-- Token Grid -->
	<div class="max-h-100 space-y-3 overflow-y-auto pr-1">
		{#if searchQuery}
			<!-- Search Results -->
			{#each getFilteredCategories() as category (category.name)}
				<div class="space-y-2">
					<div class="flex items-center gap-2 text-xs font-medium text-base-content/70">
						<category.icon class="h-3 w-3" />
						{getCategoryLabel(category.name)}
					</div>
					<div class="grid grid-cols-1 gap-2">
						{#each category.tokens as token (token.token)}
							<div
								class="group flex items-center justify-between gap-2 rounded-lg border border-base-300 bg-base-100 p-2 transition-all hover:border-primary hover:shadow-sm"
							>
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2">
										<code class="font-mono text-sm font-medium text-primary">{token.token}</code>
									</div>
									<p class="truncate text-xs text-base-content/60">{token.description}</p>
								</div>
								<div
									class="flex gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
								>
									<button
										type="button"
										class="btn btn-ghost btn-xs"
										onclick={() => handleInsert(token.token)}
										disabled={!canInsert}
										aria-label={`Insert ${token.token}`}
										title={getInsertTitle(token.token)}
									>
										<Plus class="h-3 w-3" />
									</button>
									<button
										type="button"
										class="btn btn-ghost btn-xs"
										onclick={() => handleCopy(token.token)}
										aria-label={`Copy ${token.token}`}
										title="Copy to clipboard"
									>
										{#if copiedToken === token.token}
											<Check class="h-3 w-3 text-success" />
										{:else}
											<Copy class="h-3 w-3" />
										{/if}
									</button>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/each}
		{:else if selectedCategory === 'recommended'}
			<div class="space-y-2">
				<div class="flex items-center gap-2 text-xs font-medium text-base-content/70">
					<Sparkles class="h-3 w-3" />
					{context === 'movie'
						? m.naming_tokenRecommendedForMovies()
						: context === 'series'
							? m.naming_tokenRecommendedForSeries()
							: m.naming_tokenRecommendedForGeneral()}
				</div>
				<div class="grid grid-cols-1 gap-2">
					{#each getRecommendedTokens().slice(0, 12) as token (token.token)}
						<div
							class="group flex items-center justify-between gap-2 rounded-lg border border-base-300 bg-base-100 p-2 transition-all hover:border-primary hover:shadow-sm"
						>
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<code class="font-mono text-sm font-medium text-primary">{token.token}</code>
								</div>
								<p class="truncate text-xs text-base-content/60">{token.description}</p>
							</div>
							<div
								class="flex gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
							>
								<button
									type="button"
									class="btn btn-ghost btn-xs"
									onclick={() => handleInsert(token.token)}
									disabled={!canInsert}
									aria-label={m.naming_tokenInsert({ token: token.token })}
									title={getInsertTitle(token.token)}
								>
									<Plus class="h-3 w-3" />
								</button>
								<button
									type="button"
									class="btn btn-ghost btn-xs"
									onclick={() => handleCopy(token.token)}
									aria-label={m.naming_tokenInsert({ token: token.token })}
									title={m.naming_tokenCopy()}
								>
									{#if copiedToken === token.token}
										<Check class="h-3 w-3 text-success" />
									{:else}
										<Copy class="h-3 w-3" />
									{/if}
								</button>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{:else if selectedCategory === 'conditional'}
			<div class="space-y-3">
				<div class="text-sm text-base-content/70">
					{m.naming_tokenConditionalDescription()}
				</div>
				{#each conditionalSnippets as snippet (snippet.pattern)}
					<div class="rounded-lg border border-base-300 bg-base-100 p-3">
						<div class="flex items-center justify-between gap-2">
							<code class="font-mono text-sm">{snippet.pattern}</code>
							<div class="flex gap-1">
								<button
									type="button"
									class="btn btn-ghost btn-xs"
									onclick={() => handleInsert(snippet.pattern)}
									disabled={!canInsert}
									aria-label={m.naming_tokenInsert({ token: snippet.pattern })}
									title={getInsertTitle(snippet.pattern)}
								>
									<Plus class="h-3 w-3" />
								</button>
								<button
									type="button"
									class="btn btn-ghost btn-xs"
									onclick={() => handleCopy(snippet.pattern)}
									aria-label={m.naming_tokenInsert({ token: snippet.pattern })}
								>
									<Copy class="h-3 w-3" />
								</button>
							</div>
						</div>
						<p class="mt-1 text-xs text-base-content/60">{snippet.description}</p>
						<div class="mt-2 text-xs text-success">
							{m.naming_tokenExample()}: {snippet.example}
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<!-- Category View -->
			{@const category = tokenCategories.find((c) => c.name === selectedCategory)}
			{#if category}
				<div class="space-y-2">
					<div class="flex items-center gap-2 text-xs font-medium text-base-content/70">
						<category.icon class="h-3 w-3" />
						{getCategoryLabel(category.name)}
					</div>
					<div class="grid grid-cols-1 gap-2">
						{#each category.tokens as token (token.token)}
							<div
								class="group flex items-center justify-between gap-2 rounded-lg border border-base-300 bg-base-100 p-2 transition-all hover:border-primary hover:shadow-sm"
							>
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2">
										<code class="font-mono text-sm font-medium text-primary">{token.token}</code>
									</div>
									<p class="truncate text-xs text-base-content/60">{token.description}</p>
								</div>
								<div
									class="flex gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
								>
									<button
										type="button"
										class="btn btn-ghost btn-xs"
										onclick={() => handleInsert(token.token)}
										disabled={!canInsert}
										aria-label={m.naming_tokenInsert({ token: token.token })}
										title={getInsertTitle(token.token)}
									>
										<Plus class="h-3 w-3" />
									</button>
									<button
										type="button"
										class="btn btn-ghost btn-xs"
										onclick={() => handleCopy(token.token)}
										aria-label={m.naming_tokenInsert({ token: token.token })}
										title={m.naming_tokenCopy()}
									>
										{#if copiedToken === token.token}
											<Check class="h-3 w-3 text-success" />
										{:else}
											<Copy class="h-3 w-3" />
										{/if}
									</button>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		{/if}
	</div>

	<!-- Insert Hint -->
	{#if !activeFieldId}
		<div class="alert-sm alert alert-warning">
			<span class="text-xs">{m.naming_tokenInsertHint()}</span>
		</div>
	{/if}
</div>
