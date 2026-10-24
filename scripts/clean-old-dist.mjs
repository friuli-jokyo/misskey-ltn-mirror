/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const __dirname = import.meta.dirname;
const builtDir = path.join(__dirname, '..', 'built');

function getReferencedFiles(manifestPath, distDir) {
	if (!fs.existsSync(manifestPath)) {
		console.log(`Manifest not found: ${manifestPath}`);
		return new Set();
	}

	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
	const files = new Set();

	for (const entry of Object.values(manifest)) {
		if (entry.file) {
			files.add(path.basename(entry.file));
			const dir = path.dirname(entry.file);
			if (dir !== '.') {
				files.add(dir.split('/')[0]);
			}
		}
		if (entry.css) {
			for (const cssFile of entry.css) {
				files.add(path.basename(cssFile));
				const dir = path.dirname(cssFile);
				if (dir !== '.') {
					files.add(dir.split('/')[0]);
				}
			}
		}
	}

	files.add('manifest.json');

	return files;
}

function cleanOldFiles(distDir, manifestPath) {
	if (!fs.existsSync(distDir)) {
		console.log(`Directory not found: ${distDir}`);
		return;
	}

	const referencedFiles = getReferencedFiles(manifestPath, distDir);
	console.log(`\nCleaning ${distDir}...`);
	console.log(`Protected files from manifest: ${referencedFiles.size}`);

	let deletedCount = 0;
	let protectedCount = 0;

	const entries = fs.readdirSync(distDir, { withFileTypes: true });

	for (const entry of entries) {
		const entryName = entry.name;
		
		if (entryName.startsWith('.')) {
			continue;
		}

		const shouldProtect =
			referencedFiles.has(entryName) ||
			entryName.match(/^[a-z]{2}-[A-Z]{2}$/) ||
			['scripts', 'assets', 'loader'].includes(entryName) ||
			['mockServiceWorker.js', 'draw-blurhash-CkyvlvUa.js', 'test-webgl2-Bpyoe01b.js'].includes(entryName);

		if (shouldProtect) {
			protectedCount++;
			continue;
		}

		const fullPath = path.join(distDir, entryName);
		try {
			if (entry.isDirectory()) {
				fs.rmSync(fullPath, { recursive: true, force: true });
				console.log(`  Deleted directory: ${entryName}`);
			} else {
				fs.rmSync(fullPath, { force: true });
				console.log(`  Deleted file: ${entryName}`);
			}
			deletedCount++;
		} catch (error) {
			console.error(`  Failed to delete ${entryName}:`, error.message);
		}
	}

	console.log(`  Protected: ${protectedCount} items, Deleted: ${deletedCount} items`);
}

function cleanOldFilesInAssetsDir(distDir) {
	const assetsDir = path.join(distDir, 'assets');
	const scriptsDir = path.join(distDir, 'scripts');

	if (!fs.existsSync(assetsDir) && !fs.existsSync(scriptsDir)) {
		return;
	}

	const manifestPath = path.join(distDir, 'manifest.json');
	if (!fs.existsSync(manifestPath)) {
		console.log(`No manifest.json found in ${distDir}, skipping cleanup`);
		return;
	}

	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
	const referencedAssets = new Set();
	const referencedScripts = new Set();

	for (const entry of Object.values(manifest)) {
		if (entry.file) {
			const filePath = entry.file;
			if (filePath.startsWith('assets/')) {
				referencedAssets.add(path.basename(filePath));
			} else if (filePath.startsWith('scripts/')) {
				referencedScripts.add(path.basename(filePath));
			}
		}
		if (entry.css) {
			for (const cssFile of entry.css) {
				if (cssFile.startsWith('assets/')) {
					referencedAssets.add(path.basename(cssFile));
				}
			}
		}
	}

	if (fs.existsSync(assetsDir)) {
		console.log(`\nCleaning ${assetsDir}...`);
		let deletedCount = 0;
		const assetFiles = fs.readdirSync(assetsDir);
		for (const file of assetFiles) {
			if (!referencedAssets.has(file) && !file.startsWith('.')) {
				const fullPath = path.join(assetsDir, file);
				try {
					fs.rmSync(fullPath, { force: true });
					console.log(`  Deleted: ${file}`);
					deletedCount++;
				} catch (error) {
					console.error(`  Failed to delete ${file}:`, error.message);
				}
			}
		}
		console.log(`  Deleted ${deletedCount} old asset files`);
	}

	if (fs.existsSync(scriptsDir)) {
		console.log(`\nCleaning ${scriptsDir}...`);
		let deletedCount = 0;
		const scriptFiles = fs.readdirSync(scriptsDir);
		for (const file of scriptFiles) {
			if (!referencedScripts.has(file) && !file.startsWith('.')) {
				const fullPath = path.join(scriptsDir, file);
				try {
					fs.rmSync(fullPath, { force: true });
					console.log(`  Deleted: ${file}`);
					deletedCount++;
				} catch (error) {
					console.error(`  Failed to delete ${file}:`, error.message);
				}
			}
		}
		console.log(`  Deleted ${deletedCount} old script files`);
	}
}

(async () => {
	console.log('Cleaning old dist files...');

	const frontendDistDir = path.join(builtDir, '_frontend_vite_');
	const frontendManifest = path.join(frontendDistDir, 'manifest.json');
	cleanOldFilesInAssetsDir(frontendDistDir);

	const embedDistDir = path.join(builtDir, '_frontend_embed_vite_');
	const embedManifest = path.join(embedDistDir, 'manifest.json');
	cleanOldFilesInAssetsDir(embedDistDir);

	const swDistDir = path.join(builtDir, '_sw_dist_');
	if (fs.existsSync(swDistDir)) {
		console.log(`\nCleaning ${swDistDir}...`);
		console.log('  Skipping SW cleanup (no manifest available)');
	}

	console.log('\nCleanup completed!');
})();
