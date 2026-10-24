import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig } from './vitest.config.js';

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ['test/migration/scenarios/**/*.ts'],
			testTimeout: 4 * 60 * 60 * 1000,
			hookTimeout: 30 * 60 * 1000,
			maxWorkers: 1,
			fileParallelism: false,
			bail: 1,
		},
	}),
);
