#!/usr/bin/env node
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ name: string, id: string, dataFlow: 'render' | 'capture', isVirtual: boolean }} AudioDevice
 */

/**
 * @typedef {{ device: AudioDevice }} PickSuccess
 * @typedef {{ error: string }} PickFailure
 * @typedef {PickSuccess | PickFailure} PickResult
 */

/**
 * @typedef {{ status: number, text: string }} HttpResponse
 */

/** @type {ReadonlyArray<string>} */
const CHANNELS = ['game', 'chatRender', 'chatCapture', 'media', 'aux'];

// ─── HTTP helper ──────────────────────────────────────────────────────────────

/**
 * @param {string} method
 * @param {string} url
 * @returns {Promise<HttpResponse>}
 */
function request(method, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: parseInt(u.port) || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method,
        rejectUnauthorized: false, // Sonar Engine uses a self-signed cert
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            text: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ─── Sonar connection ─────────────────────────────────────────────────────────

/**
 * Reads the SteelSeries Engine config and returns the Sonar web server address.
 * @returns {Promise<string>}
 */
async function getSonarAddress() {
  const corePropsPath = path.join(
    process.env.ProgramData || 'C:\\ProgramData',
    'SteelSeries',
    'SteelSeries Engine 3',
    'coreProps.json',
  );
  let coreProps;
  try {
    coreProps = JSON.parse(fs.readFileSync(corePropsPath, 'utf-8'));
  } catch (e) {
    throw new Error(
      `Cannot read SteelSeries Engine config at ${corePropsPath}: ${e.message}`,
    );
  }
  const resp = await request(
    'GET',
    `https://${coreProps.ggEncryptedAddress}/subApps`,
  );
  if (resp.status !== 200)
    throw new Error(`SteelSeries Engine returned HTTP ${resp.status}`);
  const data = JSON.parse(resp.text);
  const sonar = data?.subApps?.sonar;
  if (!sonar?.isEnabled)
    throw new Error('Sonar is not enabled in SteelSeries Engine');
  if (!sonar?.isReady) throw new Error('Sonar is not ready');
  if (!sonar?.isRunning) throw new Error('Sonar is not running');
  const addr = sonar?.metadata?.webServerAddress;
  if (!addr)
    throw new Error('Sonar web server address not found in Engine response');
  return addr;
}

/**
 * @param {string} addr - Sonar web server address
 * @returns {Promise<'classic' | 'streamer'>}
 */
async function getSonarMode(addr) {
  const resp = await request('GET', `${addr}/mode`);
  if (resp.status !== 200)
    throw new Error(`/mode returned HTTP ${resp.status}`);
  return JSON.parse(resp.text);
}

// ─── Sonar audio device listing ──────────────────────────────────────────────

/**
 * Returns all audio devices known to Sonar.
 * Sonar's own virtual mixing devices (isVad: true) are flagged as isVirtual.
 * @param {string} addr - Sonar web server address
 * @returns {Promise<AudioDevice[]>}
 */
async function listSonarDevices(addr) {
  const resp = await request('GET', `${addr}/audioDevices`);
  if (resp.status !== 200)
    throw new Error(`/audioDevices returned HTTP ${resp.status}`);
  return JSON.parse(resp.text).map((d) => ({
    name: d.friendlyName,
    id: d.id,
    dataFlow: d.dataFlow,
    isVirtual: d.isVad,
  }));
}

// ─── Smart name picker ────────────────────────────────────────────────────────

/**
 * Finds a device by partial name match.
 * If multiple devices match, the error includes each device's ID for disambiguation.
 * @param {AudioDevice[]} devices
 * @param {string} name
 * @returns {PickResult}
 */
function pickByName(devices, name) {
  const needle = name.toLowerCase();
  const matches = devices.filter((d) => d.name.toLowerCase().includes(needle));

  if (!matches.length) return { error: `No device found matching "${name}"` };
  if (matches.length === 1) return { device: matches[0] };

  const lines = matches.map((d) => `  ${d.name}\n    ${d.id}`).join('\n');
  return {
    error: `"${name}" matches ${matches.length} devices:\n${lines}\nUse: node index.js set "<id>"`,
  };
}

// ─── Sonar API: apply changes ─────────────────────────────────────────────────

/**
 * PUT with no request body; exits on HTTP error.
 * @param {string} addr
 * @param {string} path - full path suffix (no leading slash, value already included)
 * @returns {Promise<void>}
 */
async function applyPut(addr, path) {
  const url = `${addr}/${path}`;
  const resp = await request('PUT', url);
  if (resp.status >= 200 && resp.status < 300) return;
  console.error(`Failed (HTTP ${resp.status}) - URL: ${url}`);
  if (resp.text) console.error(resp.text);
  process.exit(1);
}

/**
 * @param {string} addr - Sonar web server address
 * @param {string} apiPath - API path suffix (no leading slash)
 * @param {string} deviceId - Windows audio endpoint device ID
 * @returns {Promise<void>}
 */
async function applyDevice(addr, apiPath, deviceId) {
  const encodedId = encodeURIComponent(deviceId);
  const url = `${addr}/${apiPath}/${encodedId}`;
  const resp = await request('PUT', url);
  if (resp.status >= 200 && resp.status < 300) {
    console.log(
      `Done (HTTP ${resp.status})${resp.text ? ': ' + resp.text : ''}`,
    );
  } else {
    console.error(`Failed (HTTP ${resp.status}) - URL: ${url}`);
    if (resp.text) console.error(resp.text);
    process.exit(1);
  }
}

// ─── GG process management ────────────────────────────────────────────────────

const GG_BASE_DIRS = [
  path.join('C:\\Program Files', 'SteelSeries', 'GG'),
  path.join('C:\\Program Files (x86)', 'SteelSeries', 'GG'),
];

/** @returns {Promise<boolean>} */
function isGGRunning() {
  return new Promise((resolve) => {
    exec(
      'tasklist /fi "imagename eq SteelSeriesGGEZ.exe" /fo csv /nh',
      (err, stdout) => {
        resolve(!err && stdout.toLowerCase().includes('steelseriesggez.exe'));
      },
    );
  });
}

/** @returns {Promise<void>} */
function killGG() {
  return new Promise((resolve, reject) => {
    exec('taskkill /f /im SteelSeriesGGEZ.exe', (err) => {
      if (err)
        reject(new Error(`Could not stop SteelSeries GG: ${err.message}`));
      else resolve();
    });
  });
}

/**
 * Starts SteelSeriesGGEZ.exe and polls until Sonar becomes ready.
 * @returns {Promise<string>} Sonar web server address
 */
async function launchGG() {
  const ggDir = GG_BASE_DIRS.find((p) => fs.existsSync(p));
  if (!ggDir) {
    throw new Error(
      'SteelSeries GG installation not found. Tried:\n' +
        GG_BASE_DIRS.map((p) => `  ${p}`).join('\n'),
    );
  }
  const exe = path.join(ggDir, 'SteelSeriesGGEZ.exe');
  if (!fs.existsSync(exe)) {
    throw new Error(`Expected executable not found: ${exe}`);
  }

  // GGez is a single-instance app — if it's already running our spawn would be a
  // no-op, leaving us polling a stale port forever. Kill it first for a clean start.
  if (await isGGRunning()) {
    process.stdout.write(
      'SteelSeries GG is running but Sonar is unavailable — restarting...\n',
    );
    await killGG();
    await new Promise((r) => setTimeout(r, 1500));
  }

  const dataPath = path.join(
    process.env.ProgramData || 'C:\\ProgramData',
    'SteelSeries',
    'GG',
  );
  const args = [`-dataPath=${dataPath}`, '-dbEnv=production', '-auto=true'];

  console.log(`Launching: ${exe}`);
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    cwd: ggDir,
  });

  // Hold briefly to catch immediate spawn errors before detaching
  let spawnError = null;
  child.on('error', (err) => {
    spawnError = err;
  });
  await new Promise((r) => setTimeout(r, 500));
  if (spawnError) throw spawnError;
  child.unref();

  const TIMEOUT_MS = 30_000;
  const POLL_MS = 2_000;
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError = '';

  process.stdout.write(
    `Waiting for Sonar to become ready (up to ${TIMEOUT_MS / 1000}s)`,
  );
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const addr = await getSonarAddress();
      process.stdout.write(`\nSonar is ready  (${addr})\n`);
      return addr;
    } catch (err) {
      lastError = err.message;
      process.stdout.write('.');
    }
  }
  process.stdout.write('\n');
  throw new Error(
    `Timed out after ${TIMEOUT_MS / 1000}s. Last status: ${lastError}`,
  );
}

/**
 * Returns the Sonar address, auto-starting SteelSeries GG if it is not running.
 * @returns {Promise<string>}
 */
async function connectToSonar() {
  process.stdout.write('Connecting to Sonar...');
  try {
    const addr = await getSonarAddress();
    process.stdout.write(` ok  (${addr})\n`);
    return addr;
  } catch {
    process.stdout.write(' not running\n');
    return launchGG();
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdGet() {
  const addr = await connectToSonar();
  const mode = await getSonarMode(addr);

  const endpoints = [
    'mode',
    'streamRedirections/',
    'streamRedirections/monitoring',
    `volumeSettings/${mode}`,
    'audioDevices',
  ];

  for (const ep of endpoints) {
    const resp = await request('GET', `${addr}/${ep}`);
    if (resp.status === 200) {
      console.log(`\n── GET /${ep} ──`);
      try {
        console.log(JSON.stringify(JSON.parse(resp.text), null, 2));
      } catch {
        console.log(resp.text);
      }
    }
  }
}

/**
 * Resolves a flag value to a device ID, fetching and filtering the device list
 * by name if the value isn't already an ID (i.e. doesn't start with "{").
 * @param {string} value - raw CLI value (ID or partial name)
 * @param {AudioDevice[]} devices - pre-fetched, pre-filtered candidate list
 * @param {string} label - "output" or "input" for error messages
 * @returns {AudioDevice}
 */
function resolveDevice(value, devices, label) {
  if (value.startsWith('{')) {
    const match = devices.find((d) => d.id === value);
    return (
      match ?? {
        name: value,
        id: value,
        dataFlow: /** @type {'render'} */ ('render'),
        isVirtual: false,
      }
    );
  }
  const result = pickByName(devices, value);
  if (result.error) {
    console.error(`--${label}: ${result.error}`);
    process.exit(1);
  }
  return result.device;
}

/**
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function cmdSet(args) {
  // Parse --output / -o and --input / -i flags
  /** @type {{ output?: string, input?: string }} */
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--output' || args[i] === '-o') && args[i + 1]) {
      flags.output = args[++i];
    } else if ((args[i] === '--input' || args[i] === '-i') && args[i + 1]) {
      flags.input = args[++i];
    }
  }

  if (!flags.output && !flags.input) {
    console.error(
      'Error: at least one of --output or --input is required.\n' +
        'Usage: node index.js set [--output <id-or-name>] [--input <id-or-name>]',
    );
    process.exit(1);
  }

  const addr = await connectToSonar();
  process.stdout.write('\n');

  // Fetch device list once, only if at least one flag needs name resolution
  const needsLookup =
    (flags.output && !flags.output.startsWith('{')) ||
    (flags.input && !flags.input.startsWith('{'));
  const allDevices = needsLookup ? await listSonarDevices(addr) : [];

  if (flags.output) {
    const candidates = allDevices.filter(
      (d) => d.dataFlow === 'render' && !d.isVirtual,
    );
    const device = resolveDevice(flags.output, candidates, 'output');
    console.log(`Output → ${device.name}\n  ${device.id}\n`);
    await applyDevice(
      addr,
      'streamRedirections/monitoring/deviceId',
      device.id,
    );
  }

  if (flags.input) {
    const candidates = allDevices.filter(
      (d) => d.dataFlow === 'capture' && !d.isVirtual,
    );
    const device = resolveDevice(flags.input, candidates, 'input');
    console.log(`Input  → ${device.name}\n  ${device.id}\n`);
    await applyDevice(addr, 'streamRedirections/mic/deviceId', device.id);
  }
}

/**
 * @param {string[]} flags
 * @returns {Promise<void>}
 */
async function cmdList(flags = []) {
  const showAll = flags.includes('--all');
  const addr = await connectToSonar();

  const all = await listSonarDevices(addr);
  const visible = showAll ? all : all.filter((d) => !d.isVirtual);
  const render = visible.filter((d) => d.dataFlow === 'render');
  const capture = visible.filter((d) => d.dataFlow === 'capture');

  /** @param {string} header @param {AudioDevice[]} devices */
  function printSection(header, devices) {
    console.log(`\n${header}`);
    if (!devices.length) {
      console.log('  (none)');
      return;
    }
    const pad = Math.max(...devices.map((d) => d.name.length)) + 2;
    for (const d of devices) {
      const tag = d.isVirtual ? '  [virtual]' : '';
      console.log(`  ${d.name.padEnd(pad)}${d.id}${tag}`);
    }
  }

  printSection('Render (playback):', render);
  printSection('Capture (mic):', capture);

  const hiddenVirtual = all.filter((d) => d.isVirtual).length;
  if (!showAll && hiddenVirtual > 0) {
    console.log(
      `\n(${hiddenVirtual} Sonar virtual devices hidden - use --all to show)`,
    );
  }
}

/**
 * @param {string[]} args
 * @param {boolean} muted
 * @returns {Promise<void>}
 */
async function cmdMute(args, muted) {
  const channel = args[0];
  if (!channel || !CHANNELS.includes(channel)) {
    console.error(
      `Error: valid channel required.\n` +
        `Usage: node index.js ${muted ? 'mute' : 'unmute'} <channel>\n` +
        `Channels: ${CHANNELS.join(', ')}`,
    );
    process.exit(1);
  }

  const addr = await connectToSonar();
  const mode = await getSonarMode(addr);
  process.stdout.write('\n');

  console.log(`${muted ? 'Muting' : 'Unmuting'} ${channel}`);
  await applyPut(addr, `volumeSettings/${mode}/${channel}/Mute/${muted}`);
  console.log('Done');
}

/**
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function cmdVolume(args) {
  const channel = args[0];
  const levelStr = args[1];

  if (!channel || !CHANNELS.includes(channel) || levelStr === undefined) {
    console.error(
      `Error: channel and level required.\n` +
        `Usage: node index.js volume <channel> <0.0-1.0>\n` +
        `Channels: ${CHANNELS.join(', ')}`,
    );
    process.exit(1);
  }

  const level = parseFloat(levelStr);
  if (isNaN(level) || level < 0 || level > 1) {
    console.error(
      `Error: level must be between 0.0 and 1.0, got "${levelStr}"`,
    );
    process.exit(1);
  }

  const addr = await connectToSonar();
  const mode = await getSonarMode(addr);
  process.stdout.write('\n');

  const volumePath =
    mode === 'classic'
      ? `volumeSettings/classic/${channel}/Volume/${level}`
      : `volumeSettings/streamer/monitoring/${channel}/Volume/${level}`;

  console.log(`${channel} volume → ${level}`);
  await applyPut(addr, volumePath);
  console.log('Done');
}

async function cmdStart() {
  await connectToSonar();
}

function printHelp() {
  console.log(`SteelSeries Sonar Device CLI

Commands:
  set [--output <id-or-name>] [--input <id-or-name>]
        Set the monitoring output device, the mic input device, or both.
        Values starting with "{" are treated as Windows audio endpoint IDs;
        anything else is a partial name matched against Sonar's device list.

        --output, -o    Render device (speakers / headphones)
        --input,  -i    Capture device (microphone)

  mute <channel>        Mute a channel
  unmute <channel>      Unmute a channel
  volume <channel> <n>  Set channel volume (0.0-1.0)

        Channels: game, chatRender, chatCapture, media, aux

  list [--all]          List Sonar audio devices (Sonar virtual devices hidden by default)
  get                   Show current Sonar routing config
  start                 Launch SteelSeries GG if not running and wait for Sonar to become ready
  help                  Show this message

Examples:
  node index.js set --output "Arctis 9 Game"
  node index.js set --input "Arctis 9 Chat"
  node index.js set --output "Arctis 9 Game" --input "Arctis 9 Chat"
  node index.js set --output "{0.0.0.00000000}.{9351f935-...}"
  node index.js mute chatCapture
  node index.js volume game 0.8
  node index.js list`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const [, , cmd, ...args] = process.argv;

(async () => {
  try {
    switch (cmd) {
      case 'get':
        await cmdGet();
        break;
      case 'set':
        await cmdSet(args);
        break;
      case 'list':
        await cmdList(args);
        break;
      case 'mute':
        await cmdMute(args, true);
        break;
      case 'unmute':
        await cmdMute(args, false);
        break;
      case 'volume':
        await cmdVolume(args);
        break;
      case 'start':
        await cmdStart();
        break;
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        printHelp();
        break;
      default:
        console.error(`Unknown command: "${cmd}"\n`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
})();
