import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../vaft/vaft.user.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const start = source.indexOf('    declareOptions(window);');
assert.ok(start > 0);
// Run the actual functions without injecting into a real browser or starting its monitor.
const instrumented = source.slice(0, start) + `
    declareOptions(window);
    globalThis.api = {
        processM3U8, getStreamUrlForResolution, getServerTimeFromM3u8,
        gqlRequest, fetchPlaylist, hookWorkerFetch, hookWindowWorker,
        doTwitchPlayerTask, handleWorkerFetchRequest, updateAdblockBanner,
        setPlayerResolver(fn) { getPlayerAndState = fn; },
        setTokenResolver(fn) { getAccessToken = fn; },
        setPlaylistProcessor(fn) { processStreamPlaylist = fn; },
        setStorageHookFailed(value) { localStorageHookFailed = value; },
        isStripping() { return isActivelyStrippingAds; }
    };
})();`;

function harness() {
    const messages = [];
    const listeners = new Map();
    const settings = new Map();
    const context = vm.createContext({
        URL, Response, AbortController, Blob, setTimeout, clearTimeout,
        console: { log() {}, debug() {}, error() {} },
        location: { pathname: '/example' },
        document: {
            addEventListener(type, listener) { listeners.set(type, listener); },
            removeEventListener(type) { listeners.delete(type); },
            querySelector() { return null; },
        },
        localStorage: {
            getItem(key) { return settings.get(key) ?? null; },
            setItem(key, value) { settings.set(key, String(value)); },
            removeItem(key) { settings.delete(key); },
        },
        postMessage(message) { messages.push(message); },
        pendingFetchRequests: new Map(),
        fetch: async () => new Response('#EXTM3U\n'),
    });
    context.window = context;
    context.self = context;
    vm.runInContext(instrumented, context);
    context.PlayerRecoveryTimeout = 30;
    context.PlayerRecoveryPollInterval = 2;
    return { context, api: context.api, messages, listeners, settings };
}

const mainUrl = 'https://cdn.test/main.m3u8';
const clean = sequence => `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:2,live\nhttps://cdn.test/${sequence}.ts\n`;
const ads = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:99\n#EXT-X-DATERANGE:ID="stitched-ad",X-TV-TWITCH-AD-TYPE="MIDROLL"\n#EXTINF:2,ad\nhttps://cdn.test/ad.ts\n';
const master = type => `#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080,FRAME-RATE=60,CODECS="avc1.test,mp4a.test"\nhttps://cdn.test/${type}.m3u8\n`;

function addStream(context) {
    const stream = {
        ChannelName: 'example', IsShowingAd: false, LastPlayerReload: 0,
        ModifiedM3U8: null, IsUsingModifiedM3U8: false, UsherParams: '?test=1',
        RequestedAds: new Set(), Urls: { [mainUrl]: { Resolution: '1920x1080', FrameRate: 60, Codecs: 'avc1.test,mp4a.test' } },
        BackupEncodingsM3U8Cache: {}, ActiveBackupPlayerType: null,
        BackupRetryAt: 0,
        PlaylistRequestSequence: 0, LastPlaylistRequest: new Map(), LastProcessedPlaylist: new Map(),
        ProcessingQueue: Promise.resolve(), CleanPlaylistCount: 0, LastCleanPlaylist: null, LastCleanSequence: null,
        NumStrippedAdSegments: 0,
    };
    context.StreamInfos.example = stream;
    context.StreamInfosByUrl[mainUrl] = stream;
    return stream;
}

function backupNetwork(h, available = () => true) {
    const calls = [];
    h.api.setTokenResolver(async (channel, type) => {
        calls.push(`token:${type}`);
        return new Response(JSON.stringify({ data: { streamPlaybackAccessToken: { signature: 'test', value: type } } }));
    });
    const fetch = async url => {
        const parsed = new URL(url);
        if (parsed.hostname === 'usher.ttvnw.net') {
            const type = parsed.searchParams.get('token');
            return new Response(master(type), { status: available(type) ? 200 : 503 });
        }
        const type = parsed.pathname.slice(1, -5);
        calls.push(`playlist:${type}`);
        return new Response(clean(100).replace('100.ts', `${type}.ts`), { status: available(type) ? 200 : 503 });
    };
    return { fetch, calls };
}

test('keeps the successful popout backup even when embed becomes available', async () => {
    const h = harness();
    const stream = addStream(h.context);
    let embedWorks = false;
    const network = backupNetwork(h, type => type !== 'embed' || embedWorks);
    assert.match(await h.api.processM3U8(mainUrl, ads, network.fetch, 1), /popout.ts/);
    assert.equal(stream.ActiveBackupPlayerType, 'popout');
    network.calls.length = 0;
    embedWorks = true;
    assert.match(await h.api.processM3U8(mainUrl, ads, network.fetch, 2), /popout.ts/);
    assert.deepEqual(network.calls, ['playlist:popout']);
});

test('reselects a fallback when the active backup stops working', async () => {
    const h = harness();
    const stream = addStream(h.context);
    let working = 'popout';
    const network = backupNetwork(h, type => type === working);
    await h.api.processM3U8(mainUrl, ads, network.fetch, 1);
    working = 'embed';
    assert.match(await h.api.processM3U8(mainUrl, ads, network.fetch, 2), /embed.ts/);
    assert.equal(stream.ActiveBackupPlayerType, 'embed');
});

test('requires advancing clean playlists and reloads only once after ads', async () => {
    const h = harness();
    const stream = addStream(h.context);
    const network = backupNetwork(h);
    await h.api.processM3U8(mainUrl, ads, network.fetch, 1);
    await h.api.processM3U8(mainUrl, clean(100), network.fetch, 2);
    await h.api.processM3U8(mainUrl, clean(100) + '#SERVER-TIME:changed\n', network.fetch, 3);
    assert.equal(stream.IsShowingAd, true);
    assert.equal(h.messages.filter(m => m.key === 'ReloadPlayer').length, 0);
    assert.equal(await h.api.processM3U8(mainUrl, clean(101), network.fetch, 4), clean(101));
    await h.api.processM3U8(mainUrl, clean(102), network.fetch, 5);
    assert.equal(stream.IsShowingAd, false);
    const reloads = h.messages.filter(m => m.key === 'ReloadPlayer');
    assert.equal(reloads.length, 1);
    assert.equal(reloads[0].channelName, 'example');
    assert.equal(reloads[0].reason, 'ad-finished');
});

test('a new ad resets pending clean confirmations', async () => {
    const h = harness();
    const stream = addStream(h.context);
    const network = backupNetwork(h);
    for (const [index, playlist] of [ads, clean(100), ads, clean(101)].entries()) {
        await h.api.processM3U8(mainUrl, playlist, network.fetch, index + 1);
    }
    assert.equal(stream.IsShowingAd, true);
    assert.equal(stream.CleanPlaylistCount, 1);
});

test('late ad responses cannot undo a completed return to the stream', async () => {
    const h = harness();
    const stream = addStream(h.context);
    const network = backupNetwork(h);
    await h.api.processM3U8(mainUrl, ads, network.fetch, 1);
    await h.api.processM3U8(mainUrl, clean(100), network.fetch, 3);
    await h.api.processM3U8(mainUrl, clean(101), network.fetch, 4);
    const result = await h.api.processM3U8(mainUrl, ads, network.fetch, 2);
    assert.equal(result, clean(101));
    assert.equal(stream.IsShowingAd, false);
});

test('playlist state mutations do not overlap and the queue recovers from errors', async () => {
    const h = harness();
    addStream(h.context);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const calls = [];
    h.api.setPlaylistProcessor(async (url, text) => {
        calls.push(text);
        if (text === 'first') { await gate; throw new Error('broken playlist'); }
        return text;
    });
    const first = h.api.processM3U8(mainUrl, 'first', null, 1);
    const rejection = assert.rejects(first, /broken playlist/);
    const second = h.api.processM3U8(mainUrl, 'second', null, 2);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['first']);
    release();
    await rejection;
    assert.equal(await second, 'second');
});

test('an abandoned stream cannot emit a recovery after a backup finishes', async () => {
    const h = harness();
    addStream(h.context);
    const network = backupNetwork(h);
    const fetch = async url => {
        const response = await network.fetch(url);
        if (url.includes('cdn.test')) h.context.StreamInfos.example = {};
        return response;
    };
    await h.api.processM3U8(mainUrl, ads, fetch, 1);
    assert.equal(h.messages.filter(m => m.key === 'ReloadPlayer' || m.event === 'backup-selected').length, 0);
});

test('missing rendition metadata still blocks identified ad segments', async () => {
    const h = harness();
    const stream = addStream(h.context);
    stream.Urls = {};
    await h.api.processM3U8(mainUrl, ads, null, 1);
    assert.ok(h.context.AdSegmentCache.has('https://cdn.test/ad.ts'));
});

test('normal playback does not trigger recovery or backup requests', async () => {
    const h = harness();
    addStream(h.context);
    assert.equal(await h.api.processM3U8(mainUrl, clean(100), () => { throw new Error('unexpected request'); }, 1), clean(100));
    assert.equal(h.messages.filter(m => m.key === 'ReloadPlayer').length, 0);
});

test('failed backups back off without delaying subsequent clean playlists', async () => {
    const h = harness();
    const stream = addStream(h.context);
    const network = backupNetwork(h, () => false);
    await h.api.processM3U8(mainUrl, ads, network.fetch, 1);
    assert.ok(stream.BackupRetryAt > Date.now());
    network.calls.length = 0;
    await h.api.processM3U8(mainUrl, ads, network.fetch, 2);
    assert.equal(network.calls.length, 0);
    await h.api.processM3U8(mainUrl, clean(100), network.fetch, 3);
    assert.equal(await h.api.processM3U8(mainUrl, clean(101), network.fetch, 4), clean(101));
    assert.equal(stream.IsShowingAd, false);
});

test('missing server-time metadata is accepted for both Twitch API formats', () => {
    const h = harness();
    assert.equal(h.api.getServerTimeFromM3u8('#EXTM3U'), null);
    h.context.V2API = true;
    assert.equal(h.api.getServerTimeFromM3u8('#EXTM3U'), null);
    assert.equal(h.api.getServerTimeFromM3u8('#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="123.5"'), '123.5');
});

test('token requests time out and remove their pending entries', async () => {
    const h = harness();
    await assert.rejects(h.api.gqlRequest({}, 'embed', 5), /timed out/);
    assert.equal(h.context.pendingFetchRequests.size, 0);
});

test('playlist timeout aborts a stalled response body', async () => {
    const h = harness();
    const fetch = async (url, { signal }) => ({
        status: 200,
        text: () => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    await assert.rejects(h.api.fetchPlaylist(mainUrl, fetch, 5), /aborted/);
});

test('the page-side token bridge aborts stalled requests', async () => {
    const h = harness();
    h.context.realFetch = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const response = await h.api.handleWorkerFetchRequest({ id: 'test', url: mainUrl, options: {}, timeout: 5 });
    assert.equal(response.error, 'aborted');
});

test('playlist processing failures reject instead of leaving fetch pending', async () => {
    const h = harness();
    addStream(h.context);
    h.context.fetch = async () => new Response(clean(100));
    h.api.setPlaylistProcessor(async () => { throw new Error('parse failed'); });
    h.api.hookWorkerFetch();
    await assert.rejects(h.context.fetch(mainUrl), /parse failed/);
});

test('a response started before a restart cannot mutate the replacement stream', async () => {
    const h = harness();
    addStream(h.context);
    let finish;
    h.context.fetch = () => new Promise(resolve => { finish = resolve; });
    h.api.hookWorkerFetch();
    const pending = h.context.fetch(mainUrl);
    const replacement = addStream(h.context);
    finish(new Response(ads));
    await pending;
    assert.equal(replacement.IsShowingAd, false);
    assert.equal(h.messages.length, 0);
});

test('rendition parsing supports arbitrary attribute order and matches frame rate', () => {
    const h = harness();
    const playlist = '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080,FRAME-RATE=30\nhttps://cdn.test/30.m3u8\n#EXT-X-STREAM-INF:FRAME-RATE=60,RESOLUTION=1920x1080\nhttps://cdn.test/60.m3u8\n';
    assert.equal(h.api.getStreamUrlForResolution(playlist, { Resolution: '1920x1080', FrameRate: 60 }), 'https://cdn.test/60.m3u8');
});

test('master playlists without optional server time or codecs do not hang', async () => {
    const h = harness();
    h.context.fetch = async () => new Response('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080,FRAME-RATE=60\nhttps://cdn.test/main.m3u8\n');
    h.api.hookWorkerFetch();
    const response = await h.context.fetch('https://usher.ttvnw.net/api/v2/channel/hls/example.m3u8?test=1');
    assert.match(await response.text(), /main.m3u8/);
    assert.equal(h.context.StreamInfosByUrl[mainUrl].ChannelName, 'example');
});

function player(paused = false) {
    let playing = !paused;
    let began = Date.now();
    let playCalls = 0;
    const video = { readyState: 2, ended: false, get paused() { return !playing; }, get currentTime() { return playing ? (Date.now() - began) / 10 : 0; } };
    return {
        core: { state: { muted: false, volume: 0.4, quality: { group: 'chunked' } } },
        getHTMLVideoElement: () => video,
        isPaused: () => !playing,
        pause() { playing = false; },
        play() { playCalls++; playing = true; began = Date.now(); return Promise.resolve(); },
        get playCalls() { return playCalls; },
    };
}

function recovery(h, onReload, old = player()) {
    let current = old;
    let reloads = 0;
    const state = { props: { content: { type: 'live' } }, setSrc() { reloads++; const replacement = onReload(reloads); if (replacement) current = replacement; } };
    h.api.setPlayerResolver(() => ({ player: current, state }));
    return { old, state, get reloads() { return reloads; } };
}

test('resumes the replacement player and coalesces simultaneous recovery requests', async () => {
    const h = harness();
    const replacement = player(true);
    const r = recovery(h, () => replacement);
    const first = h.api.doTwitchPlayerTask(false, true, 'ad-finished');
    assert.equal(h.api.doTwitchPlayerTask(false, true, 'ad-finished'), first);
    assert.equal(await first, true);
    assert.equal(r.old.playCalls, 0);
    assert.equal(replacement.playCalls, 1);
    assert.equal(r.reloads, 1);
    assert.equal(h.listeners.size, 0);
});

test('retries a failed replacement once and verifies playback progress', async () => {
    const h = harness();
    const replacement = player(true);
    const r = recovery(h, attempt => attempt === 2 ? replacement : null);
    assert.equal(await h.api.doTwitchPlayerTask(false, true, 'ad-finished'), true);
    assert.equal(r.reloads, 2);
});

test('recovery gives up after two failed attempts', async () => {
    const h = harness();
    const r = recovery(h, () => null);
    assert.equal(await h.api.doTwitchPlayerTask(false, true, 'ad-finished'), false);
    assert.equal(r.reloads, 2);
    assert.equal(h.context.vaftDiagnostics().filter(m => m.event === 'recovery-timeout').length, 2);
});

test('does not reload a paused player or VOD', async () => {
    const h = harness();
    const r = recovery(h, () => player(), player(true));
    assert.equal(await h.api.doTwitchPlayerTask(false, true), false);
    assert.equal(r.reloads, 0);
    r.state.props.content.type = 'vod';
    assert.equal(await h.api.doTwitchPlayerTask(false, true), false);
    assert.equal(r.reloads, 0);
});

test('navigation during recovery cannot resume the next channel', async () => {
    const h = harness();
    const next = player(true);
    const r = recovery(h, () => { setTimeout(() => { h.context.location.pathname = '/another'; }, 0); return next; });
    assert.equal(await h.api.doTwitchPlayerTask(false, true), false);
    assert.equal(next.playCalls, 0);
    assert.equal(r.reloads, 1);
});

test('an explicit user pause cancels automatic recovery', async () => {
    const h = harness();
    const next = player(true);
    const r = recovery(h, () => {
        setTimeout(() => h.listeners.get('click')?.({ isTrusted: true, type: 'click', target: { closest: selector => selector.startsWith('[data-a-target') ? {} : null } }), 0);
        return next;
    });
    assert.equal(await h.api.doTwitchPlayerTask(false, true), false);
    assert.equal(next.playCalls, 0);
    assert.equal(r.reloads, 1);
});

test('a return from ads queued during a codec reload still gets its own recovery', async () => {
    const h = harness();
    const replacements = [player(true), player(true)];
    const r = recovery(h, attempt => replacements[attempt - 1]);
    const first = h.api.doTwitchPlayerTask(false, true, 'ad-codec-transition');
    h.api.doTwitchPlayerTask(false, true, 'ad-finished');
    await first;
    await h.api.doTwitchPlayerTask(false, true, 'ad-finished');
    assert.equal(r.reloads, 2);
    assert.equal(replacements[1].playCalls, 1);
});

test('Firefox settings are restored while changes made during recovery are preserved', async () => {
    const h = harness();
    h.api.setStorageHookFailed(true);
    h.settings.set('volume', '0.2');
    h.settings.set('video-muted', '{"default":true}');
    const r = recovery(h, () => {
        assert.equal(h.settings.get('volume'), '0.4');
        assert.equal(h.settings.get('video-muted'), '{"default":false}');
        return player(true);
    });
    assert.equal(await h.api.doTwitchPlayerTask(false, true), true);
    assert.equal(h.settings.get('volume'), '0.2');
    assert.equal(h.settings.get('video-muted'), '{"default":true}');
    assert.equal(h.settings.has('video-quality'), false);
    assert.equal(r.reloads, 1);
    recovery(h, () => {
        h.settings.set('volume', '0.8');
        return player(true);
    });
    await h.api.doTwitchPlayerTask(false, true);
    assert.equal(h.settings.get('volume'), '0.8');
});

test('the injected Twitch worker includes and can run the updated playlist helpers', async () => {
    const h = harness();
    let workerBlob;
    const OriginalURL = URL;
    h.context.URL = class extends OriginalURL {
        static createObjectURL(blob) { workerBlob = blob; return 'blob:mock'; }
    };
    h.context.Worker = class MockWorker {
        constructor() {}
        addEventListener() {}
    };
    h.context.XMLHttpRequest = class {
        open() {}
        overrideMimeType() {}
        send() {}
        get responseText() { return ''; }
    };
    h.context.addEventListener = () => {};
    h.api.hookWindowWorker();
    new h.context.Worker('blob:https://www.twitch.tv/test');
    const workerSource = await workerBlob.text();
    const worker = harness();
    worker.context.XMLHttpRequest = h.context.XMLHttpRequest;
    worker.context.addEventListener = () => {};
    vm.runInContext(workerSource, worker.context);
    const stream = addStream(worker.context);
    assert.equal(await worker.context.processM3U8(mainUrl, clean(100), worker.context.fetch, 1), clean(100));
    assert.equal(stream.LastPlaylistRequest.get(mainUrl), 1);
});

test('stripping status updates even before the player overlay exists', () => {
    const h = harness();
    h.api.updateAdblockBanner({ isStrippingAdSegments: true });
    assert.equal(h.api.isStripping(), true);
    h.api.updateAdblockBanner({ hasAds: false });
    assert.equal(h.api.isStripping(), false);
});

test('diagnostics are bounded and contain no request credentials', () => {
    const h = harness();
    h.api.setPlayerResolver(() => null);
    for (let i = 0; i < 110; i++) h.api.doTwitchPlayerTask(false, true);
    const diagnostics = h.context.vaftDiagnostics();
    assert.equal(diagnostics.length, 100);
    assert.doesNotMatch(JSON.stringify(diagnostics), /Authorization|Client-Integrity|https:\/\//);
});
