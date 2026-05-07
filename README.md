# SSH PEM Executor

This Codex plugin exposes an MCP server that runs commands on a remote SSH host using a local PEM private key.

## Tools

- `ssh_check`: verifies connectivity by running a tiny command on the remote host.
- `ssh_run`: runs a command on the remote host and returns only the remote terminal output. Login banners, setup output, host metadata, and JSON wrappers are intentionally stripped.
- `ssh_pty_start`: starts a persistent interactive SSH PTY shell and returns a session id.
- `ssh_pty_send`: sends exact input to a persistent PTY session, such as `pwd\n`.
- `ssh_pty_read`: reads newly available output from a PTY session.
- `ssh_pty_stop`: exits and removes a PTY session.
- `ssh_pty_list`: lists PTY sessions held by the current MCP server process.

## MCP Entry Only

Codex loads this plugin through `.mcp.json`, which starts `node ./scripts/server.js` as an MCP server. The package intentionally does not expose a terminal CLI; use the Codex MCP tools directly.

## Configure

Edit `./.mcp.json` or set environment variables in the plugin install UI:

```json
{
  "SSH_PEM_HOST": "203.0.113.10",
  "SSH_PEM_USER": "ubuntu",
  "SSH_PEM_KEY_PATH": "/Users/you/.ssh/my-server.pem",
  "SSH_PEM_PORT": "22",
  "SSH_PEM_STRICT_HOST_KEY_CHECKING": "accept-new",
  "SSH_PEM_ALLOWED_HOSTS": "203.0.113.10",
  "SSH_PEM_DEFAULT_CWD": "/home/ma-user/work",
  "SSH_PEM_PERSISTENT_WORKDIR": "/home/ma-user/work",
  "SSH_PEM_REMOTE_SHELL": "/bin/bash",
  "SSH_PEM_REMOTE_SETUP_COMMAND": "source /home/ma-user/work/Ascend_Op_Challenge_S8/scripts/setup_remote_toolchain.sh 20 >/dev/null",
  "SSH_PEM_CONNECT_TIMEOUT_SECONDS": "10",
  "SSH_PEM_COMMAND_TIMEOUT_SECONDS": "30",
  "SSH_PEM_MAX_OUTPUT_BYTES": "200000"
}
```

Recommended PEM permissions:

```bash
chmod 600 /Users/you/.ssh/my-server.pem
```

## Optional Environment Variables

- `SSH_PEM_KNOWN_HOSTS_PATH`: custom known hosts file.
- `SSH_PEM_REMOTE_SHELL`: remote shell used to execute commands. Defaults to `/bin/sh`.
- `SSH_PEM_REMOTE_SETUP_COMMAND`: shell setup snippet prepended to every remote command.
- `SSH_PEM_ALLOW_RUNTIME_TARGETS`: set to `true` to allow `host`, `user`, `keyPath`, and `port` tool arguments.

Runtime target overrides are disabled by default so a model cannot silently switch hosts or keys.

## Persistence Note

For this ModelArts machine, only `/home/ma-user/work` is persistent. Files written outside that directory may disappear when the remote environment is restarted.

This plugin sets `SSH_PEM_DEFAULT_CWD=/home/ma-user/work`, so `ssh_run` commands and `ssh_pty_start` sessions begin in the persistent directory unless a different `cwd` is explicitly provided.

## Terminal Output Behavior

`ssh_run` prepends an internal marker immediately before the user command starts, then removes everything before that marker from the returned tool text. This keeps ModelArts login banners and toolchain setup chatter out of the result while preserving the command's own stdout/stderr.

`ssh_pty_start` opens `ssh -tt` and keeps the SSH process alive inside the MCP server. Use `ssh_pty_send` and `ssh_pty_read` to interact with the same remote shell, so shell state such as `cd`, exported variables, foreground jobs, prompts, and interactive program state can persist across tool calls until `ssh_pty_stop`.

The MCP protocol response is still JSON-RPC internally, but the tool content text is pure terminal output for Codex tool calls.

## ModelArts Development Baseline

For the S8 environment, this plugin can load the repository-maintained toolchain setup before each remote command:

- `SSH_PEM_REMOTE_SETUP_COMMAND` may be set to `source /home/ma-user/work/Ascend_Op_Challenge_S8/scripts/setup_remote_toolchain.sh 20 >/dev/null`.
- Generate that command from the challenge repo with `bash scripts/setup_remote_toolchain.sh --print-mcp-remote-setup 20`.
- The script configures CANN, GCC/G++, CMake, PyTorch/torch_npu paths, `TORCH_DEVICE_BACKEND_AUTOLOAD=0`, and 20-job build parallelism.

## Example Prompts

- "用 ssh_check 测试远程机器连接。"
- "通过 ssh_run 在远程机器执行 `uptime`。"
- "通过 ssh_run 在 `/home/ma-user/work` 执行 `git status --short`。"
- "用 ssh_pty_start 打开一个持久远程终端，然后用 ssh_pty_send 发送 `cd /home/ma-user/work\n`。"

## Local Smoke Test

```bash
npm run smoke
```

The smoke test starts `scripts/server.js`, performs MCP `initialize` and `tools/list`, and checks that one-shot and PTY tools are advertised.

## Security

Do not commit a real PEM key. Replace `SSH_PEM_KEY_PATH` locally or configure it in the Codex plugin UI.
