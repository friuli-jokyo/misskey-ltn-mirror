/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import cluster from 'node:cluster';
import Logger from '@/logger.js';
import { envOption } from '@/env.js';
import { loadConfig } from '@/config.js';
import type { Config } from '@/config.js';
import { configureLogging, shutdownLogging } from '@/logging/logging-runtime.js';
import { initTelemetry, shutdownTelemetry } from '@/core/telemetry/telemetry-registry.js';
import { QueueModule } from '@/core/QueueModule.js';
import { initExtraThreadPool, jobQueue, server } from './common.js';
import { installShutdownSignalHandlers } from './shutdown-handler.js';
import type { INestApplicationContext } from '@nestjs/common';

const logger = new Logger('core', 'cyan');
const bootLogger = logger.createSubLogger('boot', 'magenta');

/**
 * Init worker process
 */
export async function workerMain() {
	let config: Config;
	try {
		config = loadConfig();
		configureLogging(config.logging);
		logger.info(`Start worker process... pid: ${process.pid}`);
	} catch (e) {
		bootLogger.error(e instanceof Error ? e : new Error(String(e)), null, true);
		process.exit(1);
	}

	initExtraThreadPool(config);

	try {
		await initTelemetry(config);
	} catch (e) {
		bootLogger.error(e instanceof Error ? e : new Error(String(e)), null, true);
		process.exit(1);
	}
	installShutdownSignalHandlers({
		shutdownTasks: [shutdownTelemetry, shutdownLogging],
		onRegistered: message => bootLogger.info(message),
	});

	let serverApp: INestApplicationContext | undefined;
	let jobQueueApp: INestApplicationContext | undefined;
	if (envOption.onlyServer) {
		serverApp = await server();
		if (cluster.worker?.id === 1) {
			serverApp.get(QueueModule).startQueueEventListeners();
		}
	} else if (envOption.onlyQueue) {
		jobQueueApp = await jobQueue();
	} else {
		jobQueueApp = await jobQueue();
	}

	if (cluster.isWorker) {
		// Send a 'ready' message to parent process
		if (process.send) process.send('ready');
	}
	return {
		server: serverApp,
		jobQueue: jobQueueApp,
	};
}
