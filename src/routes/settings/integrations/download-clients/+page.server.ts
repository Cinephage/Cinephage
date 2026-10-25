import type { PageServerLoad } from './$types';
import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { getDefaultAcquisitionProtocol } from '#lib/server/settings/acquisition.js';

export const load: PageServerLoad = async () => {
	const downloadClientManager = getDownloadClientManager();
	const downloadClients = await downloadClientManager.getClients();
	const settings = await monitoringScheduler.getSettings();

	return {
		downloadClients,
		stalledDownloadTimeoutMinutes: settings.stalledDownloadTimeoutMinutes,
		stalledDownloadProgressThreshold: settings.stalledDownloadProgressThreshold,
		stalledDownloadBlocklistHours: settings.stalledDownloadBlocklistHours,
		defaultAcquisitionProtocol: getDefaultAcquisitionProtocol()
	};
};
