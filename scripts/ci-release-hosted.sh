#!/usr/bin/env bash
# Task-owned localhost SSH transport for the GitHub-hosted release matrix.
set -euo pipefail

root="${PIAB_HOST_ROOT:?PIAB_HOST_ROOT must name the private run directory}"
ssh_dir="$root/ssh"

start_ssh() {
  mkdir -m 700 "$ssh_dir" "$root/bin" "$root/mac-work" "$root/pi"
  ssh-keygen -q -t ed25519 -N '' -f "$ssh_dir/host"
  ssh-keygen -q -t ed25519 -N '' -f "$ssh_dir/client"
  cp "$ssh_dir/client.pub" "$ssh_dir/authorized_keys"
  chmod 600 "$ssh_dir/authorized_keys"
  port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
  user=$(id -un)
  printf '[127.0.0.1]:%s ' "$port" > "$ssh_dir/known_hosts"
  awk '{print $1, $2}' "$ssh_dir/host.pub" >> "$ssh_dir/known_hosts"
  printf 'Port %s\nListenAddress 127.0.0.1\nHostKey %s/host\nPidFile %s/sshd.pid\nAuthorizedKeysFile %s/authorized_keys\nStrictModes yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nPermitRootLogin no\nAllowUsers %s\nSetEnv HOME=%s/home PATH=%s PI_CODING_AGENT_DIR=%s/pi NPM_CONFIG_USERCONFIG=%s/npmrc NPM_CONFIG_GLOBALCONFIG=%s/npm-globalrc NPM_CONFIG_CACHE=%s/npm-cache NPM_CONFIG_REGISTRY=https://registry.npmjs.org/\n' \
    "$port" "$ssh_dir" "$ssh_dir" "$ssh_dir" "$user" "$root" "$PATH" "$root" "$root" "$root" "$root" > "$ssh_dir/sshd_config"
  /usr/sbin/sshd -t -f "$ssh_dir/sshd_config"
  /usr/sbin/sshd -D -e -f "$ssh_dir/sshd_config" > "$ssh_dir/sshd.log" 2>&1 &
  echo "$!" > "$ssh_dir/launched.pid"
  for _ in {1..100}; do
    if /usr/bin/ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=1 \
      -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$ssh_dir/known_hosts" \
      -o IdentitiesOnly=yes -i "$ssh_dir/client" -p "$port" "$user@127.0.0.1" true 2>/dev/null; then
      break
    fi
    kill -0 "$(< "$ssh_dir/launched.pid")" 2>/dev/null || { echo "Task-owned sshd exited; see $ssh_dir/sshd.log" >&2; return 1; }
    sleep 0.1
  done
  /usr/bin/ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=5 \
    -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$ssh_dir/known_hosts" \
    -o IdentitiesOnly=yes -i "$ssh_dir/client" -p "$port" "$user@127.0.0.1" true
  # Doctor supplies its own insecure first-contact option. For only this owned
  # loopback port, OpenSSH takes these earlier, pinned options instead.
  cat > "$root/bin/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
previous=""
owned=0
for arg in "$@"; do
  if [[ "$previous" == "-p" && "$arg" == "$PLATFORM_SMOKE_MAC_PORT" ]]; then owned=1; fi
  previous="$arg"
done
if [[ "$owned" == 1 ]]; then
  exec /usr/bin/ssh -F /dev/null -o StrictHostKeyChecking=yes \
    -o "UserKnownHostsFile=$PIAB_HOST_ROOT/ssh/known_hosts" -o IdentitiesOnly=yes \
    -i "$PIAB_HOST_ROOT/ssh/client" "$@"
fi
exec /usr/bin/ssh "$@"
SH
  chmod 700 "$root/bin/ssh"
  {
    printf 'PLATFORM_SMOKE_MAC_HOST=127.0.0.1\nPLATFORM_SMOKE_MAC_PORT=%s\nPLATFORM_SMOKE_MAC_USER=%s\n' "$port" "$user"
    printf 'PLATFORM_SMOKE_MAC_WORK_ROOT=%s/mac-work\nCRABBOX_SSH_KEY=%s/client\n' "$root" "$ssh_dir"
  } >> "${GITHUB_ENV:?}"
  printf '%s\n' "$root/bin" >> "${GITHUB_PATH:?}"
  echo "Task-owned localhost SSH is ready on port $port."
}

stop_ssh() {
  [[ -f "$ssh_dir/launched.pid" ]] || return 0
  pid=$(< "$ssh_dir/launched.pid")
  command=$(ps -p "$pid" -o command= 2>/dev/null || true)
  if [[ "$command" == *"$ssh_dir/sshd_config"* ]]; then
    kill "$pid"
  elif [[ -n "$command" ]]; then
    echo "Refusing to stop unexpected process $pid: $command" >&2
    return 1
  fi
}

case "${1:-}" in
  start-ssh) start_ssh ;;
  stop-ssh) stop_ssh ;;
  *) echo 'Usage: ci-release-hosted.sh start-ssh|stop-ssh' >&2; exit 2 ;;
esac
