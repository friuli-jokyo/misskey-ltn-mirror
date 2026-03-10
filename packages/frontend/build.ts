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
	const manifestJson = await fs.readFile(path.join(outputDir, 'manifest.json'), 'utf-8').catch(() => null);
	if (!manifestJson) {
		console.log('No manifest found, skipping old build cleanup.');
		return;
	}
	const manifest = JSON.parse(manifestJson);
	const files = new Set(Object.values(manifest).flatMap(entry => [
		path.basename(entry.file),
		...entry.css ? entry.css.map(cssFile => path.basename(cssFile)) : [],
		...entry.assets ? entry.assets.map(assetFile => path.basename(assetFile)) : [],
	]));
	for await (const file of await fs.readdir(outputDir, { recursive: true, withFileTypes: true })) {
		if (!file.isFile() || files.has(path.basename(file.name))) continue;
		await fs.rm(path.join(file.parentPath, file.name));
	}
}

async function build() {
	await removeOldBuilds();
	await viteBuild();
	await buildAllLocale();
}

await build();
