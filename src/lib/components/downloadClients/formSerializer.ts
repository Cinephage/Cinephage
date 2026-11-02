import type {
	DownloadClientFormData,
	DownloadClientImplementation,
	DownloadClientMountMode,
	DownloadPriority,
	DownloadInitialState
} from '#lib/types/downloadClient.js';
import { isBlankOrRedacted } from '#lib/shared/sensitiveSettings.js';

export interface NntpServerFormData {
	name: string;
	host: string;
	port: number;
	useSsl: boolean;
	username: string | null;
	password: string | null;
	maxConnections: number;
	priority: number;
	enabled: boolean;
}

export interface DownloadClientFormState {
	name: string;
	enabled: boolean;
	host: string;
	port: number;
	useSsl: boolean;
	urlBase: string;
	urlBaseEnabled: boolean;
	mountMode: DownloadClientMountMode | '';
	username: string;
	password: string;
	movieCategory: string;
	tvCategory: string;
	recentPriority: DownloadPriority;
	olderPriority: DownloadPriority;
	initialState: DownloadInitialState;
	sequentialDownload: boolean;
	seedRatioLimit?: string;
	seedTimeLimit?: string;
	downloadPathLocal: string;
	downloadPathRemote: string;
	tempPathLocal: string;
	tempPathRemote: string;
	maxConnections: number;
	priority: number;
	implementation: DownloadClientImplementation;
	apiToken?: string;
	removeAfterImport?: boolean;
	allowMovies: boolean;
	allowTv: boolean;
}

export function serializeDownloadClientForm(
	formState: DownloadClientFormState,
	isNntpServer: boolean,
	mode: 'add' | 'edit'
): DownloadClientFormData | NntpServerFormData {
	const normalizedUrlBase = formState.urlBase.trim().replace(/^\/+|\/+$/g, '');
	const normalizedName = formState.name.trim();
	const normalizedHost = formState.host.trim();
	const normalizedUsername = formState.username.trim();

	if (isNntpServer) {
		const data: NntpServerFormData = {
			name: normalizedName,
			host: normalizedHost,
			port: formState.port,
			useSsl: formState.useSsl,
			username: normalizedUsername || null,
			password: formState.password || null,
			maxConnections: formState.maxConnections,
			priority: formState.priority,
			enabled: formState.enabled
		};
		if (mode === 'edit' && isBlankOrRedacted(formState.password?.trim())) {
			delete (data as unknown as Record<string, unknown>).password;
		}
		return data;
	}

	if (formState.implementation === 'realdebrid' || formState.implementation === 'torbox') {
		const data: DownloadClientFormData = {
			name: normalizedName,
			implementation: formState.implementation,
			enabled: formState.enabled,
			priority: formState.priority,
			removeAfterImport: formState.removeAfterImport ?? false,
			allowMovies: formState.allowMovies,
			allowTv: formState.allowTv
		};
		const apiToken = formState.apiToken?.trim();
		if (!(mode === 'edit' && (isBlankOrRedacted(apiToken) || apiToken === '********')) && apiToken)
			data.apiToken = apiToken;
		return data;
	}

	const data: DownloadClientFormData = {
		name: normalizedName,
		implementation: formState.implementation,
		enabled: formState.enabled,
		host: normalizedHost,
		port: formState.port,
		useSsl: formState.useSsl,
		urlBase: formState.urlBaseEnabled ? normalizedUrlBase || null : null,
		mountMode: formState.implementation === 'sabnzbd' && formState.mountMode ? 'nzbdav' : null,
		username: normalizedUsername || null,
		password: formState.password || null,
		movieCategory: formState.movieCategory,
		tvCategory: formState.tvCategory,
		recentPriority: formState.recentPriority,
		olderPriority: formState.olderPriority,
		initialState: formState.initialState,
		// Seeding-goal fields: blank means "no limit pushed". removeAfterImport
		// defaults to removing (backfilled behavior) when untouched.
		seedRatioLimit: (formState.seedRatioLimit ?? '').trim() || null,
		seedTimeLimit: (formState.seedTimeLimit ?? '').trim() ? Number(formState.seedTimeLimit) : null,
		removeAfterImport: formState.removeAfterImport ?? true,
		...(formState.implementation === 'qbittorrent'
			? { sequentialDownload: formState.sequentialDownload }
			: {}),
		downloadPathLocal: formState.downloadPathLocal || null,
		downloadPathRemote: formState.downloadPathRemote || null,
		tempPathLocal: formState.tempPathLocal || null,
		tempPathRemote: formState.tempPathRemote || null,
		priority: formState.priority
	};
	if (mode === 'edit' && isBlankOrRedacted(formState.password?.trim())) {
		delete (data as unknown as Record<string, unknown>).password;
	}
	return data;
}
