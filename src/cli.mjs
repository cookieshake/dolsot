#!/usr/bin/env node
import { DolsotRuntime } from './runtime.mjs';
import { loadToolbox } from './toolbox.mjs';
import { openMcpRegistry } from './mcp-registry.mjs';
import { serveHttp, serveStdio } from './mcp-server.mjs';

const HELP = `Usage:
  dolsot --session ID [--timeout SECONDS] [CODE]
          [--toolbox MODULE:ALIAS ...]
  dolsot --list-sessions
  dolsot --reset ID|all
  dolsot mcp --transport http|stdio [--host 127.0.0.1] [--port 3000]

If CODE is omitted, read it from stdin. Set DOLSOT_SESSION_DIR to an absolute
directory to persist state between processes; without it, sessions are kept
in this process only.
`;

function parseArgs(args) {
  const options = { code: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--session' || arg === '-s') options.session = args[++i];
    else if (arg === '--timeout' || arg === '-t') options.timeout = Number(args[++i]);
    else if (arg === '--toolbox') (options.toolbox ??= []).push(args[++i]);
    else if (arg === '--list-sessions') options.list = true;
    else if (arg === '--reset') options.reset = args[++i];
    else if (arg.startsWith('-')) throw new TypeError(`unknown option: ${arg}`);
    else options.code.push(arg);
  }
  return options;
}

async function main() {
  if (process.argv[2] === 'mcp') return serveMcp(process.argv.slice(3));
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const runtime = new DolsotRuntime({
    timeoutMs: options.timeout === undefined ? undefined : Math.round(options.timeout * 1000),
  });
  if (options.list) {
    const sessions = await runtime.sessions();
    for (const session of sessions) process.stdout.write(`${session.id}\t${session.size_bytes}\n`);
    return;
  }
  if (options.reset !== undefined) {
    const count = await runtime.reset(options.reset);
    process.stdout.write(`reset ${count} session(s)\n`);
    return;
  }
  if (!options.session) {
    process.stderr.write(`--session is required when running code\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  let code = options.code.join(' ');
  if (options.code.length === 0) {
    code = '';
    for await (const chunk of process.stdin) code += chunk;
  }
  let registry;
  try {
    registry = await openMcpRegistry();
    if (registry) runtime.addToolbox('mcp', registry.toolboxes().mcp);
    for (const spec of options.toolbox ?? []) {
      const toolbox = await loadToolbox(spec);
      runtime.addToolbox(toolbox.alias, toolbox.tools);
    }
    const result = await runtime.run(options.session, code);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.value !== null) process.stdout.write(`${result.value}\n`);
    if (result.error) process.stderr.write(`${result.error}\n`);
    process.exitCode = result.exit_code;
  } finally {
    await registry?.close();
  }
}

async function serveMcp(args) {
  let transport = 'stdio';
  let host = '127.0.0.1';
  let port = 3000;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--transport') transport = args[++i];
    else if (arg === '--host') host = args[++i];
    else if (arg === '--port') port = Number(args[++i]);
    else throw new TypeError(`unknown MCP option: ${arg}`);
  }
  if (transport !== 'stdio' && transport !== 'http') throw new TypeError('--transport must be http or stdio');
  const registry = await openMcpRegistry();
  const runtime = new DolsotRuntime();
  if (registry) runtime.addToolbox('mcp', registry.toolboxes().mcp);
  let serverHandle;
  try {
    if (transport === 'stdio') serverHandle = await serveStdio(runtime, registry);
    else {
      const httpServer = await serveHttp(runtime, registry, { host, port });
      serverHandle = httpServer;
      process.stdout.write(`${httpServer.url}\n`);
    }
    await Promise.race([
      serverHandle.closed ?? new Promise(resolve => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      }),
    ]);
  } finally {
    await serverHandle?.close();
    await registry?.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
