'use strict';

const log = require('electron-log');
const https = require('https');

const { bridge } = require('../spring_api');
const springDownloader = require('../spring_downloader');
const { wizard } = require('../launcher_wizard');

let downloadQueue = [];
let isDownloading = false;

const OFFICIAL_RAPID =
	'https://repos-cdn.beyondallreason.dev/repos.gz';

const CUSTOM_RAPID =
	'https://randomguyrapid.duckdns.org/repos.gz';

function GetRapidRepo(serverAddress) {
	if (
    serverAddress &&
    serverAddress.startsWith('moddedbar.duckdns.org')
	) {
		return CUSTOM_RAPID;
	}

	return OFFICIAL_RAPID;
}

const CUSTOM_MAP_CATALOG =
    'https://moddedbar.duckdns.org/maps.json';

function FetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, response => {
            let data = '';

            if (response.statusCode !== 200) {
                response.resume();
                reject(
                    new Error(
                        `HTTP ${response.statusCode} while fetching ${url}`
                    )
                );
                return;
            }

            response.setEncoding('utf8');

            response.on('data', chunk => {
                data += chunk;
            });

            response.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (err) {
                    reject(err);
                }
            });
        }).on('error', reject);
    });
}

bridge.on('GetModdedMaps', async command => {
    const serverAddress = command && command.serverAddress;

    if (
        !serverAddress ||
        !serverAddress.startsWith('moddedbar.duckdns.org')
    ) {
        log.info(
            `Ignoring GetModdedMaps for server: ${serverAddress}`
        );

        bridge.send('ModdedMaps', {
            maps: []
        });

        return;
    }

    try {
        log.info(
            `Fetching Modded BAR map catalogue: ${CUSTOM_MAP_CATALOG}`
        );

        const maps = await FetchJson(CUSTOM_MAP_CATALOG);

        log.info(
            `Received ${maps.length} Modded BAR map(s)`
        );

        bridge.send('ModdedMaps', {
            maps: maps
        });
    } catch (err) {
        log.error(
            `Failed to fetch Modded BAR map catalogue: ${err}`
        );

        bridge.send('ModdedMaps', {
            maps: [],
            error: String(err)
        });
    }
});

bridge.on('Download', (command) => {
	for (const dl of downloadQueue) {
		if (dl.name === command.name) {
			return;
		}
	}

	downloadQueue.push(command);

	if (!isDownloading) {
		DownloadFront();
	}
});

function DownloadFront() {
	if (downloadQueue.length == 0) {
		return;
	}

	let dl = downloadQueue[downloadQueue.length - 1];
	const name = dl.name;
	const type = dl.type;
	dl.isDownloading = true;

	isDownloading = true;
	if (type === 'game') {
		// Mod stacks are created by Chobby from its enabled, installed mods.
		// They are local game definitions, not downloadable Rapid packages.
		// Let Recoil resolve their rapid:// dependencies from the installed
		// package index; never request a stack download from the launcher.
		if (name.startsWith('RandomGuy Mod Stack ')) {
			log.info('Skipping download for local Skirmish mod stack: ' + name);
			ProcessAfterDone(name, true, false);
			return;
		}
		if (name.startsWith('dev-mods:')) {
			// All development mods use our trusted Rapid repository. Ignore
			// arbitrary repository URLs supplied by UI/catalog entries.
			log.info(`Mod Hub Rapid download requested for: ${name}`);
			springDownloader.downloadRapidMod(name, CUSTOM_RAPID);
		} else {
			const requestedRapidRepo = dl.resource && dl.resource.rapidRepo;
			const rapidRepo = requestedRapidRepo || GetRapidRepo(dl.serverAddress);
			log.info(`Game download requested for: ${name}`);
			log.info(`Connected TEI server: ${dl.serverAddress}`);
			log.info(`Using Rapid repository: ${rapidRepo}`);
			springDownloader.downloadGames([name], rapidRepo);
		}
	} else if (type === 'map') {
        springDownloader.downloadMap(name, dl.serverAddress);
	} else if (type === 'engine') {
		springDownloader.downloadEngine(name);
	} else if (type === 'resource') {
		const resource = dl.resource;
		if (resource == null) {
			log.error('Resource field missing');
			return;
		}
		if (resource.url == null || resource.destination == null) {
			log.error('Resource field missing: "url" and "destination" fields are mandatory.');
			return;
		}
		if (resource.extract == null) {
			log.warn('Extract field missing, assuming false.');
			resource.extract = false;
		}
		springDownloader.downloadResource(resource);
	} else {
		log.error(`Unknown type: ${type} for download ${dl}`);
	}
}

function RemoveElement(name) {
	for (let i = 0; i < downloadQueue.length; i++) {
		const dl = downloadQueue[i];
		if (dl.name === name) {
			downloadQueue.splice(i, 1);
			return dl;
		}
	}

	return null;
}

bridge.on('AbortDownload', command => {
	log.info('Abort download', command.name, command.type);
	const dl = RemoveElement(command.name);
	if (dl == null) {
		log.info(`Cannot find element to remove for download: ${command.name}`);
		return;
	}

	if (dl.isDownloading) {
		springDownloader.stopDownload();
	} else {
		bridge.send('DownloadFinished', {
			name: command.name,
			isSuccess: false,
			isAborted: true
		});
	}
});

springDownloader.on('finished', downloadItem => {
	ProcessAfterDone(downloadItem, true, false);
});

springDownloader.on('failed', downloadItem => {
	ProcessAfterDone(downloadItem, false, false);
});

springDownloader.on('aborted', downloadItem => {
	ProcessAfterDone(downloadItem, false, true);
});

function ProcessAfterDone(name, isSuccess, isAborted) {
	if (wizard.isLauncherDownloader) {
		return;
	}

	isDownloading = false;

	// Resource downloaders report their destination path, while Chobby tracks
	// the logical QueueDownload name. Resolve the active resource back to its
	// queue item so DownloadFinished uses the same name Chobby queued.
	let completed = RemoveElement(name);
	if (completed == null) {
		for (let i = 0; i < downloadQueue.length; i++) {
			const item = downloadQueue[i];
			if (
				item.isDownloading &&
				item.type === 'resource' &&
				item.resource &&
				item.resource.destination === name
			) {
				completed = downloadQueue.splice(i, 1)[0];
				break;
			}
		}
	}
	const completedName = completed ? completed.name : name;

	bridge.send('DownloadFinished', {
		name: completedName,
		isSuccess: isSuccess,
		isAborted: isAborted
	});

	DownloadFront();
}

springDownloader.on('progress', function (downloadItem, current, total) {
	if (wizard.isLauncherDownloader) {
		return;
	}
	if (total < 1024 * 1024) {
		return; // ignore downloads less than 1MB (probably not real downloads!)
	}

	const UPDATE_INTERVAL = 100;

	let shouldUpdate = true;

	if (typeof this.prevSendTime == 'undefined') {
		this.prevSendTime = (new Date()).getTime();
	} else {
		const now = (new Date()).getTime();
		if (now - this.prevSendTime < UPDATE_INTERVAL) {
			shouldUpdate = false;
		} else {
			this.prevSendTime = now;
		}
	}

	if (shouldUpdate) {
		bridge.send('DownloadProgress', {
			name: downloadItem,
			progress: current / total,
			total: total,
		});
	}
});
