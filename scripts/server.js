#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const SERVER_NAME = "ssh-pem-executor";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05";

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
const DEFAULT_PTY_READ_TIMEOUT_MS = 250;
const DEFAULT_PTY_COLS = 120;
const DEFAULT_PTY_ROWS = 40;

const ptySessions = new Map();

function env(name, fallback = "") {
  return process.env[name] ?? fallback;
}

function parsePositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function parsePort(value) {
  const port = parsePositiveInteger(value, 22, 65_535);
  if (port < 1 || port > 65_535) {
    throw new Error(`Invalid SSH port: ${value}`);
  }
  return port;
}

function getDefaultConfig() {
  return {
    host: env("SSH_PEM_HOST"),
    user: env("SSH_PEM_USER"),
    keyPath: env("SSH_PEM_KEY_PATH"),
    port: parsePort(env("SSH_PEM_PORT", "22")),
    strictHostKeyChecking: env("SSH_PEM_STRICT_HOST_KEY_CHECKING", "accept-new"),
    knownHostsPath: env("SSH_PEM_KNOWN_HOSTS_PATH"),
    connectTimeoutSeconds: parsePositiveInteger(
      env("SSH_PEM_CONNECT_TIMEOUT_SECONDS"),
      DEFAULT_CONNECT_TIMEOUT_SECONDS,
      120,
    ),
    commandTimeoutSeconds: parsePositiveInteger(
      env("SSH_PEM_COMMAND_TIMEOUT_SECONDS"),
      DEFAULT_COMMAND_TIMEOUT_SECONDS,
      86_400,
    ),
    maxOutputBytes: parsePositiveInteger(
      env("SSH_PEM_MAX_OUTPUT_BYTES"),
      DEFAULT_MAX_OUTPUT_BYTES,
      20_000_000,
    ),
    remoteShell: env("SSH_PEM_REMOTE_SHELL", "/bin/sh"),
    remoteSetupCommand: env("SSH_PEM_REMOTE_SETUP_COMMAND"),
    defaultCwd: env("SSH_PEM_DEFAULT_CWD"),
    persistentWorkdir: env("SSH_PEM_PERSISTENT_WORKDIR"),
    allowedHosts: env("SSH_PEM_ALLOWED_HOSTS")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    allowRuntimeTargets: env("SSH_PEM_ALLOW_RUNTIME_TARGETS", "false").toLowerCase() === "true",
  };
}

function ensureSafeShell(shell) {
  if (!/^[A-Za-z0-9_./-]+$/.test(shell)) {
    throw new Error(`Unsafe remote shell path: ${shell}`);
  }
  return shell;
}

function shellQuote(value) {
  const text = String(value);
  if (text.length === 0) {
    return "''";
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function buildRemoteScript({ command, cwd, environment, setupCommand, outputMarker }) {
  const lines = ["set -e"];
  if (setupCommand) {
    lines.push(setupCommand);
  }
  if (cwd) {
    lines.push(`cd -- ${shellQuote(cwd)}`);
  }
  if (environment && typeof environment === "object" && !Array.isArray(environment)) {
    for (const [key, value] of Object.entries(environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid environment variable name: ${key}`);
      }
      lines.push(`export ${key}=${shellQuote(value)}`);
    }
  }
  if (outputMarker) {
    lines.push(`printf '%s\\n' ${shellQuote(outputMarker)}`);
  }
  lines.push(command);
  return lines.join("\n");
}

function buildRemotePtyScript({ command, cwd, environment, setupCommand, outputMarker, remoteShell }) {
  const lines = ["set -e"];
  if (setupCommand) {
    lines.push(setupCommand);
  }
  if (cwd) {
    lines.push(`cd -- ${shellQuote(cwd)}`);
  }
  if (environment && typeof environment === "object" && !Array.isArray(environment)) {
    for (const [key, value] of Object.entries(environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid environment variable name: ${key}`);
      }
      lines.push(`export ${key}=${shellQuote(value)}`);
    }
  }
  if (outputMarker) {
    lines.push(`printf '%s\\n' ${shellQuote(outputMarker)}`);
  }
  lines.push("set +e");
  if (command && command.trim()) {
    lines.push(`exec ${command}`);
  } else {
    lines.push(`exec ${remoteShell} -li`);
  }
  return lines.join("\n");
}

function appendLimited(chunks, chunk, capturedBytes, maxBytes) {
  if (capturedBytes >= maxBytes) {
    return capturedBytes;
  }

  const remainingBytes = maxBytes - capturedBytes;
  const chunkToKeep = chunk.length <= remainingBytes ? chunk : chunk.subarray(0, remainingBytes);
  chunks.push(chunkToKeep);
  return capturedBytes + chunkToKeep.length;
}

function truncateBuffer(buffer, maxBytes) {
  if (buffer.length <= maxBytes) {
    return {
      text: buffer.toString("utf8"),
      truncated: false,
    };
  }

  return {
    text: buffer.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

function stripRemotePrelude(text, marker) {
  if (!marker) {
    return text;
  }

  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) {
    return text;
  }

  return text.slice(markerIndex + marker.length).replace(/^\r?\n/, "");
}

function normalizeTerminalText(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function mergeTarget(args = {}) {
  const config = getDefaultConfig();
  const runtimeTargetProvided = Boolean(args.host || args.user || args.keyPath || args.port);

  if (runtimeTargetProvided && !config.allowRuntimeTargets) {
    throw new Error(
      "Runtime SSH target overrides are disabled. Set SSH_PEM_ALLOW_RUNTIME_TARGETS=true to allow host/user/keyPath/port tool arguments.",
    );
  }

  const target = {
    host: args.host || config.host,
    user: args.user || config.user,
    keyPath: args.keyPath || config.keyPath,
    port: args.port ? parsePort(args.port) : config.port,
    strictHostKeyChecking: config.strictHostKeyChecking,
    knownHostsPath: config.knownHostsPath,
    connectTimeoutSeconds: config.connectTimeoutSeconds,
    commandTimeoutSeconds: config.commandTimeoutSeconds,
    maxOutputBytes: config.maxOutputBytes,
    remoteShell: ensureSafeShell(config.remoteShell),
    remoteSetupCommand: config.remoteSetupCommand,
    defaultCwd: config.defaultCwd,
    persistentWorkdir: config.persistentWorkdir,
    allowedHosts: config.allowedHosts,
  };

  if (!target.host) {
    throw new Error("Missing SSH host. Set SSH_PEM_HOST or pass host with runtime targets enabled.");
  }
  if (!target.user) {
    throw new Error("Missing SSH user. Set SSH_PEM_USER or pass user with runtime targets enabled.");
  }
  if (!target.keyPath) {
    throw new Error("Missing PEM key path. Set SSH_PEM_KEY_PATH or pass keyPath with runtime targets enabled.");
  }
  if (target.allowedHosts.length > 0 && !target.allowedHosts.includes(target.host)) {
    throw new Error(`Host ${target.host} is not in SSH_PEM_ALLOWED_HOSTS.`);
  }

  target.keyPath = resolve(target.keyPath.replace(/^~(?=$|\/)/, env("HOME")));
  return target;
}

async function verifyKeyPath(keyPath) {
  await access(keyPath, fsConstants.R_OK);
}

async function runSshCommand(args) {
  if (!args || typeof args.command !== "string" || args.command.trim().length === 0) {
    throw new Error("command is required.");
  }

  const target = mergeTarget(args);
  await verifyKeyPath(target.keyPath);

  const timeoutSeconds = parsePositiveInteger(
    args.timeoutSeconds,
    target.commandTimeoutSeconds,
    86_400,
  );
  const outputMarker = `__SSH_PEM_EXECUTOR_BEGIN_${randomUUID()}__`;
  const remoteScript = buildRemoteScript({
    command: args.command,
    cwd: args.cwd ?? target.defaultCwd,
    environment: args.env,
    setupCommand: target.remoteSetupCommand,
    outputMarker,
  });

  const sshArgs = [
    "-i",
    target.keyPath,
    "-p",
    String(target.port),
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${target.connectTimeoutSeconds}`,
    "-o",
    `StrictHostKeyChecking=${target.strictHostKeyChecking}`,
  ];

  if (target.knownHostsPath) {
    sshArgs.push("-o", `UserKnownHostsFile=${resolve(target.knownHostsPath.replace(/^~(?=$|\/)/, env("HOME")))}`);
  }

  sshArgs.push(`${target.user}@${target.host}`);
  sshArgs.push(`${target.remoteShell} -lc ${shellQuote(remoteScript)} 2>&1`);

  return await new Promise((resolvePromise) => {
    const child = spawn("ssh", sshArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    const terminalChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let capturedStdoutBytes = 0;
    let capturedStderrBytes = 0;
    let terminalBytes = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      capturedStdoutBytes = appendLimited(stdoutChunks, chunk, capturedStdoutBytes, target.maxOutputBytes);
      terminalBytes = appendLimited(terminalChunks, chunk, terminalBytes, target.maxOutputBytes);
    });

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      capturedStderrBytes = appendLimited(stderrChunks, chunk, capturedStderrBytes, target.maxOutputBytes);
      terminalBytes = appendLimited(terminalChunks, chunk, terminalBytes, target.maxOutputBytes);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: null,
        signal: null,
        timedOut,
        stdout: "",
        stderr: error.message,
        terminalOutput: error.message,
        stdoutTruncated: false,
        stderrTruncated: false,
        terminalOutputTruncated: false,
        target: `${target.user}@${target.host}:${target.port}`,
        defaultCwd: target.defaultCwd || null,
        persistentWorkdir: target.persistentWorkdir || null,
      });
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      const stdout = truncateBuffer(Buffer.concat(stdoutChunks), target.maxOutputBytes);
      const stderr = truncateBuffer(Buffer.concat(stderrChunks), target.maxOutputBytes);
      const terminalOutput = stripRemotePrelude(
        Buffer.concat(terminalChunks).toString("utf8"),
        outputMarker,
      );

      resolvePromise({
        exitCode,
        signal,
        timedOut,
        stdout: stdout.text,
        stderr: stderr.text,
        terminalOutput,
        stdoutTruncated: stdout.truncated || stdoutBytes > target.maxOutputBytes,
        stderrTruncated: stderr.truncated || stderrBytes > target.maxOutputBytes,
        terminalOutputTruncated: terminalBytes >= target.maxOutputBytes,
        target: `${target.user}@${target.host}:${target.port}`,
        defaultCwd: target.defaultCwd || null,
        persistentWorkdir: target.persistentWorkdir || null,
      });
    });
  });
}

function baseSshArgs(target) {
  const sshArgs = [
    "-i",
    target.keyPath,
    "-p",
    String(target.port),
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${target.connectTimeoutSeconds}`,
    "-o",
    `StrictHostKeyChecking=${target.strictHostKeyChecking}`,
  ];

  if (target.knownHostsPath) {
    sshArgs.push("-o", `UserKnownHostsFile=${resolve(target.knownHostsPath.replace(/^~(?=$|\/)/, env("HOME")))}`);
  }

  return sshArgs;
}

function appendPtyOutput(session, chunk) {
  let text = chunk.toString("utf8");
  if (!session.preludeStripped) {
    session.preludeBuffer += text;
    const markerIndex = session.preludeBuffer.indexOf(session.outputMarker);
    if (markerIndex === -1) {
      const keepBytes = session.outputMarker.length + 4096;
      if (session.preludeBuffer.length > keepBytes) {
        session.preludeBuffer = session.preludeBuffer.slice(-keepBytes);
      }
      return;
    }
    text = session.preludeBuffer.slice(markerIndex + session.outputMarker.length).replace(/^\r?\n/, "");
    session.preludeBuffer = "";
    session.preludeStripped = true;
  }

  session.pendingText += text;
  if (session.pendingText.length > session.maxBufferedBytes) {
    const overflow = session.pendingText.length - session.maxBufferedBytes;
    session.pendingText = session.pendingText.slice(overflow);
    session.truncatedBytes += overflow;
  }
}

function takePtyOutput(session, maxBytes) {
  const limit = Math.max(1, maxBytes);
  let text = session.pendingText;
  let truncated = false;
  if (Buffer.byteLength(text, "utf8") > limit) {
    const buffer = Buffer.from(text, "utf8");
    text = buffer.subarray(0, limit).toString("utf8");
    session.pendingText = buffer.subarray(limit).toString("utf8");
    truncated = true;
  } else {
    session.pendingText = "";
  }
  return {
    text: normalizeTerminalText(text),
    truncated,
  };
}

async function waitForPtyOutput(session, timeoutMs) {
  if (session.pendingText || session.closed) {
    return;
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, timeoutMs));
}

async function startPtySession(args = {}) {
  const target = mergeTarget(args);
  await verifyKeyPath(target.keyPath);

  const rows = parsePositiveInteger(args.rows, DEFAULT_PTY_ROWS, 1000);
  const cols = parsePositiveInteger(args.cols, DEFAULT_PTY_COLS, 1000);
  const sessionId = randomUUID();
  const outputMarker = `__SSH_PEM_EXECUTOR_PTY_BEGIN_${sessionId}__`;
  const remoteScript = buildRemotePtyScript({
    command: args.command,
    cwd: args.cwd ?? target.defaultCwd,
    environment: {
      TERM: args.term || "xterm-256color",
      COLUMNS: String(cols),
      LINES: String(rows),
      ...(args.env ?? {}),
    },
    setupCommand: target.remoteSetupCommand,
    outputMarker,
    remoteShell: target.remoteShell,
  });

  const sshArgs = baseSshArgs(target);
  sshArgs.push("-tt", `${target.user}@${target.host}`);
  sshArgs.push(`${target.remoteShell} -lc ${shellQuote(remoteScript)} 2>&1`);

  const child = spawn("ssh", sshArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const session = {
    id: sessionId,
    child,
    outputMarker,
    preludeBuffer: "",
    preludeStripped: false,
    pendingText: "",
    truncatedBytes: 0,
    maxBufferedBytes: target.maxOutputBytes,
    target: `${target.user}@${target.host}:${target.port}`,
    cwd: args.cwd ?? target.defaultCwd ?? null,
    persistentWorkdir: target.persistentWorkdir || null,
    closed: false,
    exitCode: null,
    signal: null,
    createdAt: new Date().toISOString(),
  };

  child.stdout.on("data", (chunk) => appendPtyOutput(session, chunk));
  child.stderr.on("data", (chunk) => appendPtyOutput(session, chunk));
  child.on("error", (error) => {
    appendPtyOutput(session, Buffer.from(error.message));
  });
  child.on("close", (exitCode, signal) => {
    session.closed = true;
    session.exitCode = exitCode;
    session.signal = signal;
  });

  ptySessions.set(sessionId, session);
  await waitForPtyOutput(session, parsePositiveInteger(args.readTimeoutMs, 750, 10_000));
  const output = takePtyOutput(session, parsePositiveInteger(args.maxBytes, target.maxOutputBytes, target.maxOutputBytes));
  return {
    session,
    output,
  };
}

function getPtySession(sessionId) {
  const session = ptySessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown PTY session: ${sessionId}`);
  }
  return session;
}

async function readPtySession(args = {}) {
  const session = getPtySession(args.sessionId);
  const maxBytes = parsePositiveInteger(args.maxBytes, getDefaultConfig().maxOutputBytes, 20_000_000);
  await waitForPtyOutput(session, parsePositiveInteger(args.timeoutMs, DEFAULT_PTY_READ_TIMEOUT_MS, 60_000));
  return {
    session,
    output: takePtyOutput(session, maxBytes),
  };
}

async function sendPtyInput(args = {}) {
  const session = getPtySession(args.sessionId);
  if (session.closed) {
    throw new Error(`PTY session is closed: ${args.sessionId}`);
  }
  if (typeof args.input !== "string") {
    throw new Error("input is required.");
  }
  session.child.stdin.write(args.input);
  return await readPtySession({
    sessionId: args.sessionId,
    timeoutMs: args.readTimeoutMs ?? DEFAULT_PTY_READ_TIMEOUT_MS,
    maxBytes: args.maxBytes,
  });
}

async function stopPtySession(args = {}) {
  const session = getPtySession(args.sessionId);
  if (!session.closed) {
    session.child.stdin.write("exit\n");
    setTimeout(() => {
      if (!session.closed) {
        session.child.kill("SIGTERM");
      }
    }, 500).unref();
    setTimeout(() => {
      if (!session.closed) {
        session.child.kill("SIGKILL");
      }
    }, 2_000).unref();
  }
  await waitForPtyOutput(session, parsePositiveInteger(args.readTimeoutMs, 500, 10_000));
  const output = takePtyOutput(session, parsePositiveInteger(args.maxBytes, getDefaultConfig().maxOutputBytes, 20_000_000));
  ptySessions.delete(args.sessionId);
  return {
    session,
    output,
  };
}

function makeToolResult(result) {
  return {
    content: [
      {
        type: "text",
        text: result.terminalOutput ?? "",
      },
    ],
    isError: result.timedOut || (typeof result.exitCode === "number" && result.exitCode !== 0),
    _meta: {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      target: result.target,
      defaultCwd: result.defaultCwd,
      persistentWorkdir: result.persistentWorkdir,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      terminalOutputTruncated: result.terminalOutputTruncated,
    },
  };
}

function makePtyToolResult(result) {
  const failed = result.session.closed &&
    (typeof result.session.exitCode === "number" && result.session.exitCode !== 0);
  return {
    content: [
      {
        type: "text",
        text: result.output?.text ?? "",
      },
    ],
    isError: failed,
    _meta: {
      sessionId: result.session.id,
      alive: !result.session.closed,
      exitCode: result.session.exitCode,
      signal: result.session.signal,
      target: result.session.target,
      cwd: result.session.cwd,
      persistentWorkdir: result.session.persistentWorkdir,
      outputTruncated: Boolean(result.output?.truncated),
      droppedBufferedBytes: result.session.truncatedBytes,
      createdAt: result.session.createdAt,
    },
  };
}

const tools = [
  {
    name: "ssh_run",
    description: "Run a shell command on the configured SSH host using a PEM private key.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute on the remote host. On this ModelArts host, only /home/ma-user/work is persistent.",
        },
        cwd: {
          type: "string",
          description: "Optional working directory on the remote host. Defaults to SSH_PEM_DEFAULT_CWD; use /home/ma-user/work for files that must persist.",
        },
        env: {
          type: "object",
          description: "Optional environment variables to export before running the command.",
          additionalProperties: {
            type: "string",
          },
        },
        timeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: 86400,
          description: "Optional command timeout. Defaults to SSH_PEM_COMMAND_TIMEOUT_SECONDS.",
        },
        host: {
          type: "string",
          description: "Optional host override. Requires SSH_PEM_ALLOW_RUNTIME_TARGETS=true.",
        },
        user: {
          type: "string",
          description: "Optional username override. Requires SSH_PEM_ALLOW_RUNTIME_TARGETS=true.",
        },
        keyPath: {
          type: "string",
          description: "Optional PEM key path override. Requires SSH_PEM_ALLOW_RUNTIME_TARGETS=true.",
        },
        port: {
          type: "integer",
          minimum: 1,
          maximum: 65535,
          description: "Optional SSH port override. Requires SSH_PEM_ALLOW_RUNTIME_TARGETS=true.",
        },
      },
    },
  },
  {
    name: "ssh_check",
    description: "Check SSH connectivity by running a small command on the configured host.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        timeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: 120,
          description: "Optional timeout for the connectivity check.",
        },
        host: {
          type: "string",
          description: "Optional host override. Requires SSH_PEM_ALLOW_RUNTIME_TARGETS=true.",
        },
        user: {
          type: "string",
          description: "Optional username override. Requires SSH_PEM_ALLOW_RUNTIME_TARGETS=true.",
        },
        keyPath: {
          type: "string",
          description: "Optional PEM key path override. Requires SSH_PEM_ALLOW_RUNTIME_TARGETS=true.",
        },
        port: {
          type: "integer",
          minimum: 1,
          maximum: 65535,
          description: "Optional SSH port override. Requires SSH_PEM_ALLOW_RUNTIME_TARGETS=true.",
        },
      },
    },
  },
  {
    name: "ssh_pty_start",
    description: "Start a persistent interactive SSH PTY shell on the configured host.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: {
          type: "string",
          description: "Initial working directory on the remote host. Defaults to SSH_PEM_DEFAULT_CWD.",
        },
        env: {
          type: "object",
          description: "Environment variables exported before the interactive shell starts.",
          additionalProperties: {
            type: "string",
          },
        },
        command: {
          type: "string",
          description: "Optional interactive command to exec instead of the configured login shell.",
        },
        rows: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description: "PTY row count. Defaults to 40.",
        },
        cols: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description: "PTY column count. Defaults to 120.",
        },
        term: {
          type: "string",
          description: "TERM value for the remote PTY. Defaults to xterm-256color.",
        },
        readTimeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 10000,
          description: "Initial output wait timeout in milliseconds.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: 20000000,
          description: "Maximum bytes of terminal output to return.",
        },
        host: {
          type: "string",
          description: "Optional host override. Requires SSH_PEM_ALLOW_RUNTIME_TARGETS=true.",
        },
        user: {
          type: "string",
          description: "Optional username override. Requires SSH_PEM_ALLOW_RUNTIME_TARGETS=true.",
        },
        keyPath: {
          type: "string",
          description: "Optional PEM key path override. Requires SSH_PEM_ALLOW_RUNTIME_TARGETS=true.",
        },
        port: {
          type: "integer",
          minimum: 1,
          maximum: 65535,
          description: "Optional SSH port override. Requires SSH_PEM_ALLOW_RUNTIME_TARGETS=true.",
        },
      },
    },
  },
  {
    name: "ssh_pty_send",
    description: "Send exact input to a persistent SSH PTY session and return newly available terminal output.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "input"],
      properties: {
        sessionId: {
          type: "string",
          description: "Session id returned by ssh_pty_start.",
        },
        input: {
          type: "string",
          description: "Exact bytes/text to write to the remote PTY, for example `pwd\\n`.",
        },
        readTimeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 60000,
          description: "Output wait timeout in milliseconds after writing input.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: 20000000,
          description: "Maximum bytes of terminal output to return.",
        },
      },
    },
  },
  {
    name: "ssh_pty_read",
    description: "Read newly available output from a persistent SSH PTY session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId"],
      properties: {
        sessionId: {
          type: "string",
          description: "Session id returned by ssh_pty_start.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 60000,
          description: "Output wait timeout in milliseconds.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: 20000000,
          description: "Maximum bytes of terminal output to return.",
        },
      },
    },
  },
  {
    name: "ssh_pty_stop",
    description: "Stop a persistent SSH PTY session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId"],
      properties: {
        sessionId: {
          type: "string",
          description: "Session id returned by ssh_pty_start.",
        },
        readTimeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 10000,
          description: "Output wait timeout in milliseconds while stopping.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: 20000000,
          description: "Maximum bytes of terminal output to return.",
        },
      },
    },
  },
  {
    name: "ssh_pty_list",
    description: "List persistent SSH PTY sessions currently held by this MCP server process.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
];

function makeResponse(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function makeError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

async function handleRequest(request) {
  if (request.method === "initialize") {
    return makeResponse(request.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    });
  }

  if (request.method === "ping") {
    return makeResponse(request.id, {});
  }

  if (request.method === "tools/list") {
    return makeResponse(request.id, {
      tools,
    });
  }

  if (request.method === "tools/call") {
    const name = request.params?.name;
    const args = request.params?.arguments ?? {};

    if (name === "ssh_run") {
      const result = await runSshCommand(args);
      return makeResponse(request.id, makeToolResult(result));
    }

    if (name === "ssh_check") {
      const result = await runSshCommand({
        ...args,
        command: "printf 'ok\\n'; uname -a",
      });
      return makeResponse(request.id, makeToolResult(result));
    }

    if (name === "ssh_pty_start") {
      const result = await startPtySession(args);
      return makeResponse(request.id, makePtyToolResult(result));
    }

    if (name === "ssh_pty_send") {
      const result = await sendPtyInput(args);
      return makeResponse(request.id, makePtyToolResult(result));
    }

    if (name === "ssh_pty_read") {
      const result = await readPtySession(args);
      return makeResponse(request.id, makePtyToolResult(result));
    }

    if (name === "ssh_pty_stop") {
      const result = await stopPtySession(args);
      return makeResponse(request.id, makePtyToolResult(result));
    }

    if (name === "ssh_pty_list") {
      return makeResponse(request.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify([...ptySessions.values()].map((session) => ({
              sessionId: session.id,
              alive: !session.closed,
              exitCode: session.exitCode,
              signal: session.signal,
              target: session.target,
              cwd: session.cwd,
              createdAt: session.createdAt,
            })), null, 2),
          },
        ],
        isError: false,
      });
    }

    return makeError(request.id, -32602, `Unknown tool: ${name}`);
  }

  return makeError(request.id, -32601, `Method not found: ${request.method}`);
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", async (line) => {
  if (!line.trim()) {
    return;
  }

  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    writeMessage(makeError(null, -32700, `Parse error: ${error.message}`));
    return;
  }

  if (request.id === undefined || request.id === null) {
    return;
  }

  try {
    writeMessage(await handleRequest(request));
  } catch (error) {
    writeMessage(makeError(request.id, -32000, error.message));
  }
});

function closeAllPtySessions() {
  for (const session of ptySessions.values()) {
    if (!session.closed) {
      session.child.kill("SIGTERM");
    }
  }
}

process.once("SIGINT", () => {
  closeAllPtySessions();
  process.exit(130);
});

process.once("SIGTERM", () => {
  closeAllPtySessions();
  process.exit(143);
});
