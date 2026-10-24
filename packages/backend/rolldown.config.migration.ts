import { defineConfig } from 'rolldown';
import type { OutputOptions, RolldownOptions } from 'rolldown';
import config from './rolldown.config.ts';

const e2e = await config({ e2e: true }) as RolldownOptions & { output: OutputOptions };

export default defineConfig({
	...e2e,
	input: {
		runner: './test/migration/processes/runner.ts',
		writer: './test/migration/processes/writer.ts',
		probe: './test/migration/processes/probe.ts',
		schema: './test/migration/processes/schema.ts',
	},
	tsconfig: './test/tsconfig.json',
	output: {
		...e2e.output,
		dir: './test/migration/built',
		minify: false,
		entryFileNames: '[name].js',
		chunkFileNames: 'chunks/[hash].js',
	},
});
