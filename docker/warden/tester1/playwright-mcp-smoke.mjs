import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';

const runtimeDirs = [
  '/tmp/tester1-playwright-home',
  '/tmp/tester1-playwright-config',
  '/tmp/tester1-playwright-cache',
  '/tmp/tester1-playwright-output',
];
for (const directory of runtimeDirs) {
  rmSync(directory, { force: true, recursive: true });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

const mcpArgs = [
  '--headless',
  '--isolated',
  '--block-service-workers',
  '--browser=chrome',
  '--executable-path=/usr/bin/chromium',
  '--allowed-origins=http://127.0.0.1:8223;http://127.0.0.1:8224;https://estetia.tidycode.it',
  '--blocked-origins=https://estetia.it',
  '--proxy-server=http://egress-proxy:3128',
  '--proxy-bypass=127.0.0.1,localhost',
  '--output-dir=/tmp/tester1-playwright-output',
  '--output-mode=stdout',
  '--image-responses=omit',
];

const processHandle = spawn(
  '/usr/local/bin/playwright-mcp',
  mcpArgs,
  {
    cwd: '/workspace',
    env: {
      ...process.env,
      HOME: runtimeDirs[0],
      XDG_CONFIG_HOME: runtimeDirs[1],
      XDG_CACHE_HOME: runtimeDirs[2],
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);

let nextId = 1;
const pending = new Map();
const stderrLines = [];
const stdoutLines = createInterface({ input: processHandle.stdout });
const stderrReader = createInterface({ input: processHandle.stderr });

stderrReader.on('line', line => {
  stderrLines.push(line);
  if (stderrLines.length > 80) stderrLines.shift();
});

stdoutLines.on('line', line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined || message.id === null) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timer);
  if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
  else waiter.resolve(message.result);
});

function request(method, params = {}, timeoutMs = 90_000) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    processHandle.stdin.write(`${payload}\n`);
  });
}

function notify(method, params = {}) {
  processHandle.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

function text(result) {
  return (result?.content ?? [])
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function tool(name, args, expectedError = false) {
  const result = await request('tools/call', { name, arguments: args });
  if (expectedError) {
    assert(result?.isError === true, `${name} unexpectedly succeeded: ${text(result)}`);
  } else {
    assert(result?.isError !== true, `${name} failed: ${text(result)}`);
  }
  return result;
}

async function main() {
  const initialized = await request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'tester1-boundary-smoke', version: '1.0.0' },
  });
  assert(initialized?.serverInfo?.name, 'MCP initialize returned no server identity');
  assert(
    !mcpArgs.includes('--allow-unrestricted-file-access'),
    'Unrestricted file access flag must never be present',
  );
  notify('notifications/initialized');

  const listed = await request('tools/list');
  const toolNames = new Set((listed?.tools ?? []).map(item => item.name));
  for (const required of [
    'browser_navigate',
    'browser_snapshot',
    'browser_click',
    'browser_file_upload',
    'browser_close',
  ]) {
    assert(toolNames.has(required), `Required MCP tool missing: ${required}`);
  }
  console.log(`PASS mcp_initialized server=${initialized.serverInfo.name}`);
  console.log('PASS unrestricted_file_access_flag_absent');

  let result = await tool('browser_navigate', { url: 'http://127.0.0.1:8223/' });
  result = await tool('browser_snapshot', {});
  assert(text(result).includes('QA 8223 ready'), 'Port 8223 page marker missing');
  console.log('PASS qa_local_8223');

  const uploadLine = text(result)
    .split('\n')
    .find(line => line.includes('QA upload') && line.includes('[ref='));
  assert(uploadLine, 'Upload control ref missing from accessibility snapshot');
  const uploadRef = uploadLine.match(/\[ref=([^\]]+)\]/)?.[1];
  assert(uploadRef, 'Upload control ref could not be parsed');
  await tool('browser_click', { element: 'QA upload control', target: uploadRef });
  const uploadDenied = await tool(
    'browser_file_upload',
    { paths: ['/etc/hostname'] },
    true,
  );
  assert(
    /outside|workspace|restricted|denied|allow/i.test(text(uploadDenied)),
    `Upload failed for an unexpected reason: ${text(uploadDenied)}`,
  );
  await tool('browser_file_upload', {});
  console.log('PASS upload_outside_workspace_denied');

  result = await tool('browser_navigate', { url: 'http://127.0.0.1:8224/' });
  result = await tool('browser_snapshot', {});
  assert(text(result).includes('QA 8224 ready'), 'Port 8224 page marker missing');
  console.log('PASS qa_local_8224');

  const fileDenied = await tool(
    'browser_navigate',
    { url: 'file:///etc/hostname' },
    true,
  );
  assert(
    /file|blocked|denied|allow/i.test(text(fileDenied)),
    `file:// failed for an unexpected reason: ${text(fileDenied)}`,
  );
  console.log('PASS file_url_denied');

  const originDenied = await tool(
    'browser_navigate',
    { url: 'https://example.com/' },
    true,
  );
  assert(
    /origin|blocked|denied|allow/i.test(text(originDenied)),
    `Arbitrary origin failed for an unexpected reason: ${text(originDenied)}`,
  );
  console.log('PASS arbitrary_origin_denied');

  const redirectDenied = await tool(
    'browser_navigate',
    { url: 'http://127.0.0.1:8223/redirect' },
    true,
  );
  assert(
    /proxy|tunnel|failed|denied|blocked|ERR_/i.test(text(redirectDenied)),
    `Redirect egress failed for an unexpected reason: ${text(redirectDenied)}`,
  );
  console.log('PASS redirect_egress_denied_by_proxy');

  await tool('browser_close', {});
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(`FAIL ${error.message}`);
  if (stderrLines.length) {
    console.error('MCP stderr tail:');
    console.error(stderrLines.join('\n'));
  }
} finally {
  processHandle.stdin.end();
  const exited = new Promise(resolve => processHandle.once('exit', resolve));
  setTimeout(() => processHandle.kill('SIGTERM'), 2_000).unref();
  await exited;
  for (const directory of runtimeDirs) {
    rmSync(directory, { force: true, recursive: true });
  }
}

process.exitCode = exitCode;
