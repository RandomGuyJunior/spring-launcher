'use strict';

const { gui } = require('./launcher_gui');
const { log } = require('./spring_log');
const path = require('path');
const fs = require('fs');
const { renameSyncWithRetry } = require('./fs_utils');
const { app, BrowserWindow, dialog } = require('electron');
const { writePath } = require('./spring_platform');
const {
        applyDefaults,
        applyModdedConfig,
        hotReloadSafe,
        reloadConfig,
        validateNewConfig,
        config,
} = require('./launcher_config');

function handleConfigUpdate(newConfig) {
	validateNewConfig(newConfig);

	const newConfigStr = JSON.stringify(newConfig, null, 4);

	newConfig = applyDefaults(newConfig);
	newConfig = applyModdedConfig(newConfig);

	const reloadType = hotReloadSafe(newConfig);

	const finalConfigPath = path.join(writePath, 'config.json');
	if (reloadType != 'identical' || !fs.existsSync(finalConfigPath)) {
		log.info('Writing new version of config.json to disk');
		const tmpConfigFile = path.join(writePath, 'config.new.json');
		fs.writeFileSync(tmpConfigFile, newConfigStr);
		renameSyncWithRetry(tmpConfigFile, finalConfigPath);
	}
	return [newConfig, reloadType];
}

function handleConfigReload(newConfig, reloadType) {
	switch (reloadType) {
		case 'identical':
			log.info('Config files are identical');
			break;
		case 'restart':
			log.info('Config files are different - restarting');

			if (process.platform == 'win32') {
				app.relaunch();
			} else {
				// Unfortunatelly on Linux relaunch doesn't work correctly
				dialog.showMessageBoxSync(BrowserWindow.getAllWindows()[0], {
					type: 'info',
					buttons: ['OK'],
					defaultId: 0,
					title: 'Restart required',
					message: 'Updated launcher configuration, this requires application restart. Closing launcher.',
				});
			}
			app.exit();
			break;
		case 'reload': {
			log.info('Current config changed, reloading steps');
			const oldConfigId = config.package.id;
			reloadConfig(newConfig);
			config.setConfig(oldConfigId);
			gui.send('all-configs', config.getAvailableConfigs());
			// We resolve it only here once to resolve issue with cicrular dependency on wizard.
			require('./launcher_wizard_util').generateAndBroadcastWizard();
			break;
		}
		case 'same-setup':
			log.info('Current config is the same, continuing');
			// In case current config is the same but the list of configs changed
			// we refresh that list.
			reloadConfig(newConfig);
			gui.send('all-configs', config.getAvailableConfigs());
			break;
	}
}

module.exports = {
	handleConfigUpdate,
	handleConfigReload,
};
