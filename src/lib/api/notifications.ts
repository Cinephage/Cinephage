import { apiDelete, apiGet, apiPatch, apiPost } from './client.js';

export type NotificationConnectionConfig = Record<string, unknown>;

export interface NotificationConnection {
	id: string;
	name: string;
	provider: string;
	enabled: boolean;
	events: string[];
	config: NotificationConnectionConfig;
	/** Secret fields that already hold a stored value; values are never returned. */
	configuredSecrets: string[];
	consecutiveFailures: number;
	disabledUntil: string | null;
	lastSuccessAt: string | null;
	lastAttemptAt: string | null;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface NotificationProviderField {
	key: string;
	labelKey: string;
	type: 'text' | 'password' | 'url' | 'select' | 'number' | 'boolean';
	required?: boolean;
	placeholder?: string;
	helpKey?: string;
	options?: Array<{ value: string; labelKey: string }>;
	default?: string | number | boolean;
	secret?: boolean;
}

export interface NotificationProvider {
	id: string;
	label: string;
	fields: NotificationProviderField[];
}

export interface NotificationDelivery {
	id: string;
	connectionId: string;
	connectionName: string | null;
	connectionProvider: string | null;
	event: string;
	ok: boolean;
	statusCode: number | null;
	error: string | null;
	durationMs: number | null;
	createdAt: string;
}

export interface NotificationTestResult {
	ok: boolean;
	status?: number;
	error?: string;
}

export async function listNotificationConnections() {
	return apiGet<{ connections: NotificationConnection[] }>('/api/notifications/connections');
}

export async function createNotificationConnection(body: {
	name: string;
	provider: string;
	enabled?: boolean;
	events?: string[];
	config?: NotificationConnectionConfig;
}) {
	return apiPost<{ connection: NotificationConnection }>('/api/notifications/connections', body);
}

export async function updateNotificationConnection(
	id: string,
	body: Partial<{
		name: string;
		provider: string;
		enabled: boolean;
		events: string[];
		config: NotificationConnectionConfig;
	}>
) {
	return apiPatch<{ connection: NotificationConnection }>(
		`/api/notifications/connections/${id}`,
		body
	);
}

export async function deleteNotificationConnection(id: string) {
	return apiDelete<{ success: boolean }>(`/api/notifications/connections/${id}`);
}

export async function testNotificationConnection(id: string) {
	return apiPost<NotificationTestResult>(`/api/notifications/connections/${id}/test`);
}

export async function listNotificationDeliveries(limit = 25) {
	return apiGet<{ deliveries: NotificationDelivery[] }>('/api/notifications/deliveries', {
		limit: String(limit)
	});
}
