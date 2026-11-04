// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import BugReportForm from './BugReportForm.svelte';

const fetchDiagnosticsMock = vi.hoisted(() => vi.fn());
const clipboardMock = vi.hoisted(() => vi.fn());
const releaseMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/api/index.js', () => ({
	fetchBugReportDiagnostics: fetchDiagnosticsMock,
	buildBugReportLogsUrl: (query: { logScope: string }) =>
		`/api/system/diagnostics/report/logs?logScope=${query.logScope}`
}));

vi.mock('#lib/api/settings.js', () => ({
	getGithubRelease: releaseMock
}));

vi.mock('#lib/utils/clipboard.js', () => ({
	copyToClipboard: clipboardMock
}));

function diagnosticsResponse() {
	return {
		success: true,
		system: {
			version: '1.2.3',
			commit: 'abc1234',
			node: 'v22.17.0',
			os: 'Debian GNU/Linux 12',
			platform: 'linux',
			arch: 'x64',
			schemaVersion: 169,
			uptimeSeconds: 3600,
			deployment: 'docker',
			osRelease: 'Debian GNU/Linux 12',
			githubOsOption: 'Linux (Debian/Ubuntu)',
			githubDeploymentOption: 'Docker'
		},
		logs: {
			scope: 'relevant',
			scopeDescription: 'Error ID abc and correlated requests',
			entries: [
				{
					id: 'log-entry-1',
					time: '11-04 14:31:58',
					level: 'error',
					domain: 'indexers',
					message: 'DanishBytes: test connection failed (502)'
				}
			],
			totalMatched: 1,
			trimmedCount: 0
		},
		generatedAt: '2026-11-04T14:32:00.000Z'
	};
}

describe('BugReportForm', () => {
	beforeEach(() => {
		fetchDiagnosticsMock.mockReset();
		fetchDiagnosticsMock.mockResolvedValue(diagnosticsResponse());
		releaseMock.mockReset();
		releaseMock.mockResolvedValue({ version: '1.2.3' });
		clipboardMock.mockReset();
		clipboardMock.mockResolvedValue(true);
	});

	afterEach(() => {
		cleanup();
	});

	it('fetches diagnostics with the default scope on mount and lists the matched entries', async () => {
		render(BugReportForm);

		await waitFor(() => {
			expect(fetchDiagnosticsMock).toHaveBeenCalledWith(
				expect.objectContaining({ logScope: 'relevant' })
			);
		});
		// The matched entry shows in the log slice preview.
		expect(await screen.findAllByText(/DanishBytes: test connection failed/)).not.toHaveLength(0);
		// Without an Error ID, the area select drives the "relevant" scope.
		expect(document.querySelector('#bug-report-log-area')).toBeTruthy();
	});

	it('hides the area select when an Error ID drives the scope', async () => {
		render(BugReportForm, { props: { initialSupportId: 'deadbeef' } });

		await waitFor(() => {
			expect(fetchDiagnosticsMock).toHaveBeenCalledWith(
				expect.objectContaining({ supportId: 'deadbeef' })
			);
		});
		expect(document.querySelector('#bug-report-log-area')).toBeNull();
	});

	it('copies the version + commit for the issue form version field', async () => {
		render(BugReportForm);
		await screen.findAllByText(/DanishBytes: test connection failed/);

		await fireEvent.click(await screen.findByRole('button', { name: /Copy version/ }));
		expect(clipboardMock).toHaveBeenCalledWith('1.2.3 (commit abc1234)');
	});

	it('copies the scoped log slice for the issue form logs field', async () => {
		render(BugReportForm);
		await screen.findAllByText(/DanishBytes: test connection failed/);

		await fireEvent.click(await screen.findByRole('button', { name: /Copy logs/ }));
		expect(clipboardMock).toHaveBeenCalledWith(
			expect.stringContaining('[11-04 14:31:58] ERROR indexers: DanishBytes')
		);
	});

	it('refetches when the log scope changes', async () => {
		render(BugReportForm);
		await screen.findAllByText(/DanishBytes: test connection failed/);

		const errorsRadio = document.querySelector(
			'input[name="bug-report-log-scope"][value="errors"]'
		) as HTMLInputElement;
		expect(errorsRadio).toBeTruthy();
		await fireEvent.click(errorsRadio);

		await waitFor(() => {
			expect(fetchDiagnosticsMock).toHaveBeenCalledWith(
				expect.objectContaining({ logScope: 'errors' })
			);
		});
	});
});
