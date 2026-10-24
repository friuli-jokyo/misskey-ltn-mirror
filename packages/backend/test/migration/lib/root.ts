/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { cpSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backendDir, repoDir } from './env.js';
import { sourceConfig } from './source-config.js';
import type { Run } from './env.js';
import type { SourceConfigInput } from './source-config.js';

const repoConfigFiles = [join(repoDir, 'built', '.config.json'), join(repoDir, 'built', '._config_.json')];

export function repoConfigState(): Record<string, number | null> {
	return Object.fromEntries(repoConfigFiles.map(path => [path, existsSync(path) ? statSync(path).mtimeMs : null]));
}

export class HarnessRoot {
	public readonly dir: string;
	public readonly bundleDir: string;
	private readonly configPath: string;

	constructor(run: Run) {
		this.dir = run.path('root');
		this.bundleDir = join(this.dir, 'bundle');
		this.configPath = join(this.dir, 'built', '.config.json');
	}

	public create(): void {
		const built = join(backendDir, 'test', 'migration', 'built');
		if (!existsSync(join(built, 'schema.js'))) throw new Error(`${built} has no harness bundle; run it with pnpm test:migration.`);
		mkdirSync(join(this.dir, 'packages'), { recursive: true });
		mkdirSync(join(this.dir, 'built'), { recursive: true });
		const { version } = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf-8')) as { version: string };
		writeFileSync(join(this.dir, 'built', 'meta.json'), JSON.stringify({ version: `${version}-e2e` }));
		symlinkSync(join(backendDir, 'node_modules'), join(this.dir, 'node_modules'), 'dir');
		cpSync(built, this.bundleDir, { recursive: true });
	}

	public writeConfig(input: SourceConfigInput): void {
		writeFileSync(this.configPath, JSON.stringify(sourceConfig(input), null, '\t'));
	}
}
