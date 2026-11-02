<script lang="ts">
	import { SectionHeader } from '#lib/components/ui/modal/index.js';
	import DownloadClientSettings from './forms/DownloadClientSettings.svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		name: string;
		host: string;
		port: number;
		useSsl: boolean;
		enabled: boolean;
		username: string;
		password: string;
		urlBase: string;
		urlBaseEnabled: boolean;
		mountMode: 'nzbdav' | 'altmount' | '';
		isNntpServer: boolean;
		usesApiKey: boolean;
		isSabnzbd: boolean;
		mode: 'add' | 'edit';
		hasPassword: boolean;
		selectedDefinitionName: string;
		maxNameLength: number;
		nameTooLong: boolean;
		urlBasePlaceholder: string;
		onSslChange: () => void;
	}

	let {
		name = $bindable(),
		host = $bindable(),
		port = $bindable(),
		useSsl = $bindable(),
		enabled = $bindable(),
		username = $bindable(),
		password = $bindable(),
		urlBase = $bindable(),
		urlBaseEnabled = $bindable(),
		mountMode = $bindable(),
		isNntpServer,
		usesApiKey,
		isSabnzbd,
		mode,
		hasPassword,
		selectedDefinitionName = '',
		maxNameLength,
		nameTooLong,
		urlBasePlaceholder,
		onSslChange
	}: Props = $props();
</script>

<SectionHeader title={m.connection_section_title()} />

<div class="form-control">
	<label class="label py-1" for="name">
		<span class="label-text">
			{m.common_name()}
			<span class="text-error">* </span>
		</span>
	</label>
	<input
		id="name"
		type="text"
		class="input-bordered input input-sm"
		bind:value={name}
		maxlength={maxNameLength}
		placeholder={selectedDefinitionName || 'My Download Client'}
	/>
	<div class="label py-1">
		<span class="label-text-alt text-xs {nameTooLong ? 'text-error' : 'text-base-content/60'}">
			{name.length}/{maxNameLength}
		</span>
		{#if nameTooLong}
			<span class="label-text-alt text-xs text-error"
				>{m.validation_maxChars({ max: maxNameLength })}</span
			>
		{/if}
	</div>
</div>

<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
	<div class="form-control">
		<label class="label py-1" for="host">
			<span class="label-text">
				{m.connection_host_label()}
				<span class="text-error">* </span>
			</span>
		</label>
		<input
			id="host"
			type="text"
			class="input-bordered input input-sm"
			bind:value={host}
			placeholder="localhost"
		/>
	</div>

	<div class="form-control">
		<label class="label py-1" for="port">
			<span class="label-text">
				{m.common_port()}
				<span class="text-error">* </span>
			</span>
		</label>
		<input
			id="port"
			type="number"
			class="input-bordered input input-sm"
			bind:value={port}
			min="1"
			max="65535"
		/>
	</div>
</div>

{#if usesApiKey}
	<div class="form-control">
		<label class="label py-1" for="password">
			<span class="label-text">
				{m.auth_apiKey_label()}
				{#if mode === 'add' || !hasPassword}
					<span class="text-error">* </span>
				{/if}
				{#if mode === 'edit' && hasPassword}
					<span class="text-xs opacity-50">({m.auth_blankToKeep()})</span>
				{/if}
			</span>
		</label>
		<input
			id="password"
			type="password"
			class="input-bordered input input-sm"
			bind:value={password}
			placeholder={mode === 'edit' && hasPassword ? '********' : 'Find in SABnzbd Config > General'}
		/>
		<div class="label py-1">
			<span class="label-text-alt text-xs">
				{m.downloadClient_apiKeyHelp()}
			</span>
		</div>
	</div>
{:else}
	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
		<div class="form-control">
			<label class="label py-1" for="username">
				<span class="label-text">{m.auth_username_label()}</span>
			</label>
			<input
				id="username"
				type="text"
				class="input-bordered input input-sm"
				bind:value={username}
				placeholder="admin"
			/>
		</div>

		<div class="form-control">
			<label class="label py-1" for="password">
				<span class="label-text">
					{m.auth_password_label()}
					{#if mode === 'add' || !hasPassword}
						<span class="text-error">* </span>
					{/if}
					{#if mode === 'edit' && hasPassword}
						<span class="text-xs opacity-50">({m.auth_blankToKeep()})</span>
					{/if}
				</span>
			</label>
			<input
				id="password"
				type="password"
				class="input-bordered input input-sm"
				bind:value={password}
				placeholder={mode === 'edit' && hasPassword ? '********' : ''}
			/>
		</div>
	</div>
{/if}

<div class="flex gap-4">
	<label class="label cursor-pointer gap-2">
		<input
			type="checkbox"
			class="checkbox checkbox-sm checkbox-primary"
			bind:checked={useSsl}
			onchange={onSslChange}
		/>
		<span class="label-text">{m.connection_useSsl_label()}</span>
	</label>

	<label class="label cursor-pointer gap-2">
		<input type="checkbox" class="checkbox checkbox-sm checkbox-primary" bind:checked={enabled} />
		<span class="label-text">{m.common_enabled()}</span>
	</label>
</div>

{#if !isNntpServer}
	<DownloadClientSettings
		mode="connection"
		bind:urlBaseEnabled
		bind:urlBase
		{urlBasePlaceholder}
		showMountMode={isSabnzbd}
		bind:mountMode
	/>
{/if}
