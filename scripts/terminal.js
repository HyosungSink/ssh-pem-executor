#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, "..");

function usage(exitCode = 2) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: ssh-pem-run [--cwd DIR] [--timeout SECONDS] -- COMMAND\n`);
  stream.write(`       ssh-pem-run [--cwd DIR] [--timeout SECONDS] "COMMAND"\n`);
  process.exit(exitCode);
}

function shellQuote(value) {
  const text = String(value);
  if (text.length === 0) {
    return "''";
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseArgs(argv) {
  const args = {
    cwd: undefined,
    timeoutSeconds: undefined,
    commandParts: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      usage(0);
    }

    if (arg === "--cwd") {
      args.cwd = argv[++index];
      if (!args.cwd) {
        usage();
      }
      continue;
    }

    if (arg === "--timeout") {
      const value = Number.parseInt(argv[++index] ?? "", 10);
      if (!Number.isFinite(value) || value <= 0) {
        usage();
      }
      args.timeoutSeconds = value;
      continue;
    }

    if (arg === "--") {
      args.commandParts = argv.slice(index + 1);
      break;
    }

    args.commandParts.push(arg);
  }

  return args;
}

async function loadPluginEnv() {
  const configPath = resolve(pluginRoot, ".mcp.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const server = config.mcpServers?.["ssh-pem-executor"];
  if (!server) {
    throw new Error(`Missing ssh-pem-executor server in ${configPath}`);
  }
  return server.env ?? {};
}

async function callMcpTool({ command, cwd, timeoutSeconds }) {
  const child = spawn(process.execPath, [resolve(scriptDir, "server.js")], {
    cwd: pluginRoot,
    env: {
      ...(await loadPluginEnv()),
      ...process.env,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const rl = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  const responsePromise = new Promise((resolvePromise, reject) => {
    rl.once("line", (line) => {
      try {
        resolvePromise(JSON.parse(line));
      } catch (error) {
        reject(new Error(`Invalid MCP response: ${error.message}`));
      }
    });
    child.once("error", reject);
  });

  const toolArgs = { command };
  if (cwd) {
    toolArgs.cwd = cwd;
  }
  if (timeoutSeconds) {
    toolArgs.timeoutSeconds = timeoutSeconds;
  }

  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "ssh_run",
      arguments: toolArgs,
    },
  })}\n`);

  const response = await responsePromise;
  child.kill("SIGTERM");

  if (response.error) {
    process.stderr.write(`${response.error.message}\n`);
    return 1;
  }

  const result = response.result ?? {};
  const text = result.content?.map((item) => item.text ?? "").join("") ?? "";
  process.stdout.write(text);

  const meta = result._meta ?? {};
  if (meta.timedOut) {
    return 124;
  }
  if (typeof meta.exitCode === "number") {
    return meta.exitCode;
  }
  return result.isError ? 1 : 0;
}

const parsed = parseArgs(process.argv.slice(2));
let command = parsed.commandParts.length === 1
  ? parsed.commandParts[0]
  : parsed.commandParts.map(shellQuote).join(" ");

if (!command.trim()) {
  command = await readStdin();
}

if (!command.trim()) {
  usage();
}

try {
  const exitCode = await callMcpTool({
    command,
    cwd: parsed.cwd,
    timeoutSeconds: parsed.timeoutSeconds,
  });
  process.exit(exitCode);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
