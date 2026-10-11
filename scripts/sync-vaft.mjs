import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('../vaft/vaft.user.js', import.meta.url));
const targetPath = fileURLToPath(new URL('../vaft/vaft-ublock-origin.js', import.meta.url));
const source = (await readFile(sourcePath, 'utf8')).replaceAll('\r\n', '\n');
const start = source.indexOf('(function() {');
if (start < 0) throw new Error('Could not locate the vaft entry point');
const body = source.slice(start).replace('(function() {\n',
    '(function() {\n    if ( /(^|\\.)twitch\\.tv$/.test(document.location.hostname) === false ) { return; }\n');
const expected = 'twitch-videoad.js text/javascript\n' + body;
if (process.argv.includes('--check')) {
    const actual = (await readFile(targetPath, 'utf8')).replaceAll('\r\n', '\n');
    if (actual !== expected) throw new Error('Run node scripts/sync-vaft.mjs to sync the uBlock resource');
    console.log('vaft userscript and uBlock resource match');
} else {
    await writeFile(targetPath, expected);
    console.log('Updated vaft/vaft-ublock-origin.js');
}
