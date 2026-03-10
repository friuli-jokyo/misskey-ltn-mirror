import * as fs from 'fs/promises';
import url from 'node:url';
import path from 'node:path';
import { execa } from 'execa';
import locales from 'i18n';
import { LocaleInliner } from '../frontend-builder/locale-inliner.js'
import { createLogger } from '../frontend-builder/logger';

// requires node 21 or later
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const outputDir = __dirname + '/../../built/_frontend_vite_';

/**
 * @return {Promise<void>}
 */
async function viteBuild() {
	await execa('vite', ['build'], {
		cwd: __dirname,
		stdout: process.stdout,
		stderr: process.stderr,
	});
}


async function buildAllLocale() {
	const logger = createLogger()
	const inliner = await LocaleInliner.create({
		outputDir,
		logger,
		scriptsDir: 'scripts',
		i18nFile: 'src/i18n.ts',
	})

	await inliner.loadFiles();

	inliner.collectsModifications();

	await inliner.saveAllLocales(locales);

	if (logger.errorCount > 0) {
		throw new Error(`Build failed with ${logger.errorCount} errors and ${logger.warningCount} warnings.`);
	}
}

async function removeOldBuilds() {
	const manifest = JSON.parse(await fs.readFile(path.join(outputDir, 'manifest.json'), 'utf-8'));
	const files = new Set(Object.values(manifest).map(entry => entry.file));
	for await (const file of await fs.readdir(outputDir, { recursive: true, withFileTypes: true })) {
		if (!file.isFile() || files.has(path.relative(outputDir, path.join(file.parentPath, file.name)))) continue;
		await fs.rm(path.join(file.parentPath, file.name));
	}
}

async function build() {
	await removeOldBuilds();
	await viteBuild();
	await buildAllLocale();
}

await build();
