# SSH PEM Executor

This Codex plugin exposes an MCP server that runs commands on a remote SSH host using a local PEM private key.

## Tools

- `ssh_check`: verifies connectivity by running a tiny command on the remote host.
- `ssh_run`: runs a command on the remote host and returns only the remote terminal output. Login banners, setup output, host metadata, and JSON wrappers are intentionally stripped.

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
  "SSH_PEM_REMOTE_SETUP_COMMAND": ". /home/ma-user/Ascend/cann-8.5.0/set_env.sh\nexport PATH=/home/ma-user/gcc/bin:/home/ma-user/cmake-3.28.3-linux-aarch64/bin:$PATH\nexport PYTORCH_SITE=/home/ma-user/anaconda3/envs/MindSpore/lib/python3.9/site-packages\nexport LD_LIBRARY_PATH=/home/ma-user/gcc/lib64:$PYTORCH_SITE/torch/lib:$PYTORCH_SITE/torch_npu/lib:/home/ma-user/anaconda3/envs/MindSpore/lib:$ASCEND_OPP_PATH/vendors/customize/op_api/lib:$ASCEND_OPP_PATH/built-in/op_impl/ai_core/tbe/op_api/lib/linux/aarch64:$LD_LIBRARY_PATH\nexport CC=/home/ma-user/gcc/bin/gcc\nexport CXX=/home/ma-user/gcc/bin/g++\nexport TORCH_DEVICE_BACKEND_AUTOLOAD=0\nexport MAX_JOBS=20\nexport CMAKE_BUILD_PARALLEL_LEVEL=20\nexport MAKEFLAGS=-j20\nexport REMOTE_BUILD_JOBS=20",
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

This plugin sets `SSH_PEM_DEFAULT_CWD=/home/ma-user/work`, so `ssh_run` commands execute from the persistent directory unless a different `cwd` is explicitly provided.

## Terminal Output Behavior

`ssh_run` prepends an internal marker immediately before the user command starts, then removes everything before that marker from the returned tool text. This keeps ModelArts login banners and toolchain setup chatter out of the result while preserving the command's own stdout/stderr.

The MCP protocol response is still JSON-RPC internally, but the tool content text is pure terminal output.

## ModelArts Development Baseline

This plugin also loads the user-installed competition toolchain before each remote command:

- CANN toolkit: `/home/ma-user/Ascend/cann-8.5.0`
- GCC/G++: `/home/ma-user/gcc/bin`, version 10.3.0
- CMake: `/home/ma-user/cmake-3.28.3-linux-aarch64/bin`
- Runtime libraries: PyTorch, torch_npu, CANN op_api, and customized op_api paths.
- PyTorch backend autoload is disabled with `TORCH_DEVICE_BACKEND_AUTOLOAD=0`; still import `torch` and `torch_npu` before importing a compiled `custom_ops_lib`.
- Build parallelism: `20` jobs, about 83% of the available `24 vCPUs | 192 GiB` quota.

## Example Prompts

- "用 ssh_check 测试远程机器连接。"
- "通过 ssh_run 在远程机器执行 `uptime`。"
- "通过 ssh_run 在 `/home/ma-user/work` 执行 `git status --short`。"

## Local Smoke Test

```bash
cd plugins/ssh-pem-executor
npm run smoke
```

## Security

Do not commit a real PEM key. Replace `SSH_PEM_KEY_PATH` locally or configure it in the Codex plugin UI.
