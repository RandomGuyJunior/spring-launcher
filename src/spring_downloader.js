'use strict';

const EventEmitter = require('events');

const { log } = require('./spring_log');
const prdDownloader = require('./prd_downloader');
const httpDownloader = require('./http_downloader');
const CUSTOM_MAP_SEARCH = 'https://moddedbar.duckdns.org/find';

class SpringDownloader extends EventEmitter {
	constructor() {
		super();

		this.currentDownloader = null;
		this.mapFallback = null;

		let downloaders = [prdDownloader, httpDownloader];
		for (const downloader of downloaders) {
			downloader.on('started', (downloadItem) => {
				this.emit('started', downloadItem);
			});

			downloader.on('progress', (downloadItem, current, total) => {
				this.emit('progress', downloadItem, current, total);
			});

			downloader.on('finished', (downloadItem) => {
				this.mapFallback = null;
				this.setDownloader(null);
				this.emit('finished', downloadItem);
			});

			downloader.on('failed', (downloadItem, msg) => {
			if (
					downloader === prdDownloader &&
					this.mapFallback &&
					this.mapFallback.name === downloadItem &&
					!this.mapFallback.attempted
			) {
				this.mapFallback.attempted = true;

				log.info(
						`Official map download failed for "${downloadItem}", trying custom map service`
				);

				prdDownloader.downloadMap(
					downloadItem,
					CUSTOM_MAP_SEARCH,
					false
				);

				return;
			}

				this.mapFallback = null;
				this.setDownloader(null);
				this.emit('failed', downloadItem, msg);
			});

			downloader.on('aborted', (downloadItem, msg) => {
				this.mapFallback = null;
				this.setDownloader(null);
				this.emit('aborted', downloadItem, msg);
			});
		}
	}

	setDownloader(downloader) {
		if (downloader != null && this.currentDownloader != null) {
			throw new Error('Sring downloader already downloading');
		}
		this.currentDownloader = downloader;
	}

	downloadEngine(engineName) {
		this.setDownloader(prdDownloader);
		prdDownloader.downloadEngine(engineName);
	}

	downloadGames(gameNames, rapidRepo) {
		this.setDownloader(prdDownloader);
		prdDownloader.downloadGames(gameNames, rapidRepo);
	}

	downloadMap(mapName, serverAddress) {
        this.setDownloader(prdDownloader);

        if (
                serverAddress &&
                serverAddress.startsWith('moddedbar.duckdns.org')
        ) {
                this.mapFallback = {
                        name: mapName,
                        attempted: false,
                };
        } else {
                this.mapFallback = null;
        }

        prdDownloader.downloadMap(mapName);
	}

	downloadResource(resource) {
		this.setDownloader(httpDownloader);
		httpDownloader.downloadResource(resource);
	}

	stopDownload() {
		if (this.currentDownloader == null) {
			log.error('No current download. Nothing to stop');
			return;
		}
		this.currentDownloader.stopDownload();
	}
}

module.exports = new SpringDownloader();
