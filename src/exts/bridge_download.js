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

// Only Mod Hub-owned .sdd directories may be removed here. Rapid .sdp
// packages share pool objects and require a separate reference-safe remover.
const fs = require('fs');
const path = require('path');
const springPlatform = require('../spring_platform');
const zlib = require('zlib');
const uninstallingMods = new Set();

bridge.on('UninstallMod', async command => {
	const id = command && command.id;
	const tag = command && command.tag;
	const requestId = command && command.requestId;
	const respond = (success, error) => bridge.send('UninstallModResult', {
		id, requestId, success, ...(error ? {error} : {})
	});
	if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id) ||
		tag !== 'dev-mods:' + id || typeof requestId !== 'string' || !requestId) {
		respond(false, 'Invalid Mod Hub uninstall request.');
		return;
	}
	if (uninstallingMods.has(id) || downloadQueue.some(item => item.name === tag)) {
		respond(false, 'This mod is currently being downloaded or uninstalled.');
		return;
	}
	uninstallingMods.add(id);
	try {
		const gamesDir = path.resolve(springPlatform.writePath, 'games');
		const target = path.resolve(gamesDir, id + '.sdd');
		if (path.dirname(target) !== gamesDir || !target.endsWith('.sdd')) {
			throw new Error('Invalid mod directory.');
		}
		const stat = await fs.promises.lstat(target).catch(err => {
			if (err.code === 'ENOENT') return null;
			throw err;
		});
		if (!stat) {
			// Rapid stores the package manifest under rapid/packages/<hash>.sdp.
			// Resolve the exact tag from the trusted repo index, not a directory
			// search or a filename guessed from the mod ID.
			const repoHost = new URL(CUSTOM_RAPID).hostname;
			const repoCache = path.join(springPlatform.writePath, 'rapid', repoHost);
			// Rapid's repos.gz is a directory of repositories. Each entry
			// provides a short name and a URL to that repository's versions.gz.
			// There is no universal /versions.gz at the master URL.
			const repos = zlib.gunzipSync(await fs.promises.readFile(
				path.join(repoCache, 'repos.gz'))).toString('utf8');
			const repoRows = repos.split(/\\r?\\n/).map(line => line.trim().split(/\\s*,\\s*/));
			const repoRow = repoRows.find(parts => parts[0] === 'dev-mods');
			if (!repoRow || !repoRow[1]) {
				throw new Error('dev-mods repository is missing from cached Rapid repos.gz.');
			}
			const versionsUrl = new URL('versions.gz', repoRow[1].endsWith('/') ? repoRow[1] : repoRow[1] + '/');
			if (versionsUrl.protocol !== 'https:' || versionsUrl.hostname !== repoHost) {
				throw new Error('Refusing an untrusted Rapid repository index URL.');
			}
			const indexBytes = await new Promise((resolve, reject) => {
				const request = https.get(versionsUrl, response => {
					if (response.statusCode !== 200) {
						response.resume();
						reject(new Error('Rapid version index unavailable (HTTP ' + response.statusCode + ').'));
						return;
					}
					const chunks = [];
					response.on('data', chunk => chunks.push(chunk));
					response.on('end', () => resolve(Buffer.concat(chunks)));
					response.on('error', reject);
				});
				request.setTimeout(10000, () => request.destroy(new Error('Rapid version index request timed out.')));
				request.on('error', reject);
			});
			const entries = zlib.gunzipSync(indexBytes).toString('utf8')
				.split(/\\r?\\n/).map(line => line.trim().split(/\\s*,\\s*/));
			// Rapid versions rows are: package hash, tag, display name.
			const matches = entries.filter(parts =>
				parts[1] === tag && /^[0-9a-fA-F]{32}$/.test(parts[0] || ''));
			if (matches.length !== 1) {
				throw new Error('Cannot resolve exactly one Rapid package for ' + tag + '; nothing deleted.');
			}
			const hash = matches[0][0].toLowerCase();
			const sharedTags = entries.filter(parts =>
				parts[1] !== tag && (parts[0] || '').toLowerCase() === hash);
			if (sharedTags.length) {
				throw new Error('Cannot uninstall: Rapid package is shared with ' + sharedTags[0][1] + '.');
			}
			const pkgPath = path.resolve(springPlatform.writePath, 'packages', hash + '.sdp');
			const packagesDir = path.resolve(springPlatform.writePath, 'packages');
			if (path.dirname(pkgPath) !== packagesDir) throw new Error('Unsafe Rapid package path.');
			const pkgStat = await fs.promises.lstat(pkgPath);
			if (!pkgStat.isFile() || pkgStat.isSymbolicLink()) throw new Error('Unsafe Rapid package file.');
			// The Rapid pool is shared with BAR and Hosting. Never delete pool
			// blocks based solely on one package tag.
			await fs.promises.unlink(pkgPath);
			log.info('Removed Rapid package manifest: ' + pkgPath);
			respond(true);
			return;
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error('Refusing to remove a non-directory or symbolic link.');
		}
		// Do not delete arbitrary local .sdd games: require the Mod Hub
		// marker created by its own installation process.
		const marker = path.join(target, '.randomguy-modhub-owned');
		const markerStat = await fs.promises.lstat(marker).catch(err => {
			if (err.code === 'ENOENT') return null;
			throw err;
		});
		if (!markerStat || !markerStat.isFile() || markerStat.isSymbolicLink()) {
			throw new Error('Directory is not marked as Mod Hub-owned; refusing deletion.');
		}
		const markerTag = (await fs.promises.readFile(marker, 'utf8')).trim();
		if (markerTag !== tag) {
			throw new Error('Mod ownership marker does not match the requested mod.');
		}
		await fs.promises.rm(target, {recursive: true, force: false});
		log.info('Removed Mod Hub .sdd: ' + target);
		respond(true);
	} catch (err) {
		log.warn('Mod uninstall rejected: ' + err);
		respond(false, String(err.message || err));
	} finally {
		uninstallingMods.delete(id);
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
