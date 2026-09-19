'use strict';

const { spawn } = require('child_process');
const EventEmitter = require('events');

const log = require('electron-log');

const springPlatform = require('./spring_platform');
const fs = require('fs');

class PrdDownloader extends EventEmitter {
	constructor() {
		super();
		this.progressPattern = new RegExp('[0-9]+/[0-9]+');
	}

	downloadPackage(name, args, envOverrides = {}, emitStarted = true) {
		let finished = false;

		if (!fs.existsSync(springPlatform.prDownloaderPath)) {
			if (process.platform == 'win32') {
				this.emit('failed', name,
					'\'pr-downloader.exe\' file is missing. This issue may be caused by an ' +
					'antivirus program, such as Avast, accidentally deleting the file. ' +
					'Please ensure your antivirus is up-to-date (or e.g., '+
					'<a target="_blank" href="https://www.google.com/search?q=How+to+add+a+folder+to+%3Cyour+antivirus%3E+antivirus+exclusion+list">'+
					'add install folder to exceptions list</a>), and reinstall the game.');
			} else {
				this.emit('failed', name,
					'pr-downloader binary not found in the installation directory.');
			}
			return;
		}

		const prd = spawn(springPlatform.prDownloaderPath, args, {
			env: {
			...process.env,
			...envOverrides,
			}
		});
		if (emitStarted) {
			this.emit('started', name);
		}

		prd.stdout.on('data', (data) => {
			const line = data.toString();
			log.info(line);
			if (line.startsWith('[Progress]')) {
				const matched = line.match(this.progressPattern);
				if (!matched || matched.length == 0) {
					return;
				}
				const progressStr = matched[0];
				var [current, total] = progressStr.split('/');
				current = parseInt(current);
				total = parseInt(total);
				this.emit('progress', name, current, total);
			} else if (line.startsWith('[Info]')) {
				this.emit('info', name, line);
			}
		});

		prd.stderr.on('data', (data) => {
			const line = data.toString();
			log.warn(line);
		});

		prd.on('close', (code) => {
			if (finished) { // the process already counts as finished
				return;
			}
			if (code == 0) {
				this.emit('finished', name);
			} else if (code == 5) {
				this.emit('failed', name, 'Failed to download: disk too full. Need a least 1 GiB free.');
			} else {
				this.emit('failed', name, `Download failed: ${name}: ${code}`);
			}
		});

		prd.on('error', (error) => {
			finished = true;
			this.emit('failed', name, `Failed to launch pr-downloader: ${error}`);
		});

		this.prd = prd;
		this.name = name;
	}

	downloadEngine(engineName) {
		this.downloadPackage(engineName, ['--filesystem-writepath', springPlatform.writePath, '--download-engine', engineName]);
	}

	downloadGames(gameNames, rapidRepo) {
		const args = ['--filesystem-writepath', springPlatform.writePath];

		for (const game of gameNames) {
			args.push(...['--download-game', game]);
		}

		const envOverrides = {};

		if (rapidRepo) {
			envOverrides.PRD_RAPID_REPO_MASTER = rapidRepo;
			log.info(`PRD_RAPID_REPO_MASTER = ${rapidRepo}`);
		}

		this.downloadPackage(
			gameNames.join(', '),
			args,
			envOverrides
		);
	}

	downloadMap(mapName, httpSearchUrl = null, emitStarted = true) {
        const envOverrides = {};

        if (httpSearchUrl) {
                envOverrides.PRD_HTTP_SEARCH_URL = httpSearchUrl;
                log.info(`PRD_HTTP_SEARCH_URL = ${httpSearchUrl}`);
        }

        this.downloadPackage(
                mapName,
                ['--filesystem-writepath', springPlatform.writePath, '--download-map', mapName],
                envOverrides,
                emitStarted
        );
	}

	downloadResource(resource) {
		throw `downloadResource(${resource['url']}, ${resource[']destination']}): pr_downloader cannot be used to download resources`;
	}

	stopDownload() {
		if (this.name == null) {
			return;
		}

		// this.prd.kill('SIGKILL');
		this.prd.kill(9);
		this.emit('aborted', this.name, 'Download interrupted via user action.');
	}
}

module.exports = new PrdDownloader();
