#!/usr/bin/env node
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ name: string, id: string, dataFlow: 'render' | 'capture', isVirtual: boolean }} AudioDevice
 */

/**
 * @typedef {{ device: AudioDevice, note?: string }} PickSuccess
 * @typedef {{ error: string }} PickFailure
 * @typedef {PickSuccess | PickFailure} PickResult
 */

/**
 * @typedef {{ status: number, text: string }} HttpResponse
 */

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

// ─── Sonar API: apply a device change ────────────────────────────────────────

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
    console.error(`Failed (HTTP ${resp.status}) — URL: ${url}`);
    if (resp.text) console.error(resp.text);
    process.exit(1);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdGet() {
  process.stdout.write('Connecting to Sonar...');
  const addr = await getSonarAddress();
  process.stdout.write(` ok  (${addr})\n`);

  // Probe every known GET endpoint so the full API state is visible.
  // This is the best way to identify correct paths for any missing features (e.g. mic routing).
  const endpoints = [
    'streamRedirections/',
    'streamRedirections/monitoring',
    'volumeSettings/streamer',
    'audioDevices',
    'audioDivert',
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
    return match ?? { name: value, id: value, dataFlow: /** @type {'render'} */ ('render'), isVirtual: false };
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

  process.stdout.write('Connecting to Sonar...');
  const addr = await getSonarAddress();
  process.stdout.write(' ok\n\n');

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
    await applyDevice(addr, 'streamRedirections/monitoring/deviceId', device.id);
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
  process.stdout.write('Connecting to Sonar...');
  const addr = await getSonarAddress();
  process.stdout.write(' ok\n');

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
      `\n(${hiddenVirtual} Sonar virtual devices hidden — use --all to show)`,
    );
  }
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

  list [--all]          List Sonar audio devices (Sonar virtual devices hidden by default)
  get                   Show current Sonar routing config
  help                  Show this message

Examples:
  node index.js set --output "Arctis 9 Game"
  node index.js set --input "Arctis 9 Chat"
  node index.js set --output "Arctis 9 Game" --input "Arctis 9 Chat"
  node index.js set --output "{0.0.0.00000000}.{9351f935-...}"
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
