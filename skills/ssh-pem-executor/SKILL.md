---
name: ssh-pem-executor
description: Use the SSH PEM Executor MCP tools to check connectivity and run commands on a configured remote SSH host.
---

# SSH PEM Executor

Use this skill when the user asks to run a command on their configured SSH machine through the SSH PEM Executor MCP plugin.

## Workflow

1. Use `ssh_check` before the first remote command in a session when connectivity has not been verified.
2. Use `ssh_run` for one-shot commands, passing `command`, and optionally `cwd`, `env`, or `timeoutSeconds`.
3. Use `ssh_pty_start`, `ssh_pty_send`, `ssh_pty_read`, and `ssh_pty_stop` when the user needs a persistent interactive terminal where shell state survives across calls.
4. If the MCP tool is unavailable, install or enable the Codex plugin instead of using direct `ssh`, terminal CLI aliases, hand-written JSON-RPC, or `node <<'NODE'` heredocs.
5. Treat `/home/ma-user/work` as the only persistent directory on this remote machine. Put projects, downloads, generated files, checkpoints, and other durable artifacts there.
6. Keep commands narrow and explain destructive or high-impact operations before running them.
7. Do not pass private key material as command text. The plugin expects a local PEM path in `SSH_PEM_KEY_PATH`.

## Notes

- Host, user, port, and key path should normally come from plugin environment variables.
- Runtime target overrides require `SSH_PEM_ALLOW_RUNTIME_TARGETS=true`.
- `SSH_PEM_DEFAULT_CWD` is set to `/home/ma-user/work` for this machine.
- Every remote command loads the competition baseline through `SSH_PEM_REMOTE_SETUP_COMMAND`: CANN 8.5.0, GCC/G++ 10.3.0, CMake 3.28.3, and `REMOTE_BUILD_JOBS=20`.
- `TORCH_DEVICE_BACKEND_AUTOLOAD=0` is set, but Python tests should still import `torch` and `torch_npu` before importing a compiled `custom_ops_lib`.
- The usable quota is `24 vCPUs | 192 GiB`; use around 20 parallel jobs unless memory pressure or tool limits require less.
- `ssh_run` and PTY tools show a compact status block in content, then `--- output ---`, then remote terminal output. JSON-RPC plumbing and local wrapper code are not part of the user-facing transcript.
- A PTY session is process-local to the running MCP server. Stop it with `ssh_pty_stop` when finished so the remote shell does not linger.
