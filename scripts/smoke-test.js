#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const child = spawn(process.execPath, ["./scripts/server.js"], {
  cwd: new URL("..", import.meta.url),
  stdio: ["pipe", "pipe", "inherit"],
});

const rl = createInterface({
  input: child.stdout,
  crlfDelay: Infinity,
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function readResponse() {
  const [line] = await once(rl, "line");
  return JSON.parse(line);
}

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "smoke-test",
      version: "0.1.0",
    },
  },
});

const initialize = await readResponse();
if (!initialize.result?.serverInfo?.name) {
  throw new Error("initialize did not return serverInfo");
}

send({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {},
});

const list = await readResponse();
const names = list.result?.tools?.map((tool) => tool.name) ?? [];
if (!names.includes("ssh_run") || !names.includes("ssh_check")) {
  throw new Error(`tools/list missing expected tools: ${names.join(", ")}`);
}

child.kill("SIGTERM");
console.log("smoke-test: ok");
