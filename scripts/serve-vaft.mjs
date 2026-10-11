import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const files = new Map([
    ['/vaft/vaft-ublock-origin.js', new URL('../vaft/vaft-ublock-origin.js', import.meta.url)],
    ['/vaft/vaft.user.js', new URL('../vaft/vaft.user.js', import.meta.url)],
]);
const port = Number(process.env.VAFT_PORT || 8765);
const server = createServer(async (req, res) => {
    const file = files.get(new URL(req.url, 'http://127.0.0.1').pathname);
    if (!file || !['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(404).end();
        return;
    }
    try {
        const source = await readFile(file);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : source);
    } catch {
        res.writeHead(500).end('Could not read the vaft resource');
    }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
    console.log(`vaft resource: http://127.0.0.1:${port}/vaft/vaft-ublock-origin.js`);
});
