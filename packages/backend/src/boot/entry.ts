/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Misskey Entry Point!
 */

import cluster from 'node:cluster';
import { EventEmitter } from 'node:events';
import chalk from 'chalk';
import Xev from 'xev';
import type { INestApplicationContext } from '@nestjs/common';
import Logger from '@/logger.js';
import { ServerService } from '@/server/ServerService.js';
import { envOption } from '../env.js';
import { masterMain } from './master.js';
import { workerMain } from './worker.js';
import { readyRef } from './ready.js';

import 'reflect-metadata';

process.title = `Misskey (${cluster.isPrimary ? 'master' : 'worker'})`;

Error.stackTraceLimit = Infinity;
EventEmitter.defaultMaxListeners = 128;

const logger = new Logger('core', 'cyan');
const clusterLogger = logger.createSubLogger('cluster', 'orange');
const ev = new Xev();

//#region Events

// Listen new workers
cluster.on('fork', worker => {
	clusterLogger.debug(`Process forked: [${worker.id}]`);
});

// Listen online workers
cluster.on('online', worker => {
	clusterLogger.debug(`Process is now online: [${worker.id}]`);
});

// Listen for dying workers
cluster.on('exit', worker => {
	// Replace the dead worker,
	// we're not sentimental
	clusterLogger.error(chalk.red(`[${worker.id}] died :(`));
	cluster.fork();
});

// Display detail of unhandled promise rejection
if (!envOption.quiet) {
	process.on('unhandledRejection', console.dir);
}

// Display detail of uncaught exception
process.on('uncaughtException', err => {
	try {
		logger.error(err);
		console.trace(err);
	} catch { }
});

// Dying away...
process.on('exit', code => {
	logger.info(`The process is going to exit with code ${code}`);
});

//#endregion

let server: INestApplicationContext | undefined;
let jobQueue: INestApplicationContext | undefined;
if (!envOption.disableClustering) {
	if (cluster.isPrimary) {
		logger.info(`Start main process... pid: ${process.pid}`);
		const apps = await masterMain();
		if (apps.server) {
			server = apps.server;
		}
		if (apps.jobQueue) {
			jobQueue = apps.jobQueue;
		}
		ev.mount();
	} else if (cluster.isWorker) {
		logger.info(`Start worker process... pid: ${process.pid}`);
		const apps = await workerMain();
		if (apps.server) {
			server = apps.server;
		}
		if (apps.jobQueue) {
			jobQueue = apps.jobQueue;
		}
	} else {
		throw new Error('Unknown process type');
	}
} else {
	// 非clusterの場合はMasterのみが起動するため、Workerの処理は行わない(cluster.isWorker === trueの状態でこのブロックに来ることはない)
	logger.info(`Start main process... pid: ${process.pid}`);
	const apps = await masterMain();
	if (apps.server) {
		server = apps.server;
	}
	if (apps.jobQueue) {
		jobQueue = apps.jobQueue;
	}
	ev.mount();
}

readyRef.value = true;

await server?.get(ServerService).ready();

// ユニットテスト時にMisskeyが子プロセスで起動された時のため
// それ以外のときは process.send は使えないので弾く
if (process.send) {
	process.send('ok');
}
