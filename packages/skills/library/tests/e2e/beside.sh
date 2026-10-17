# Sourced by tools/e2e-skill before inside.js runs: a real OpenSSH server beside AnythingLLM, in its
# network namespace (so at 127.0.0.1:2222 inside it, and nowhere else), for the targets check. The
# key AnythingLLM signs in with and the server's host key are made here; inside.js gets the private
# key and the host key's fingerprint, as the user gives them on the Library page.
ssh-keygen -q -t ed25519 -N "" -C e2e -f "$work/client_key"
ssh-keygen -q -t ed25519 -N "" -C e2e-host -f "$work/host_key"
beside="$name-sshd"
"$engine" run -d --rm --name "$beside" --network "container:$name" \
  -v "$work/client_key.pub:/e2e/authorized_keys:ro,Z" -v "$work/host_key:/e2e/host_key:ro,Z" docker.io/library/alpine:3.22 sh -c '
    apk add --no-cache openssh-server >/dev/null &&
    adduser -D sandbox && echo "sandbox:*" | chpasswd -e &&
    install -d -m 700 -o sandbox /home/sandbox/.ssh && install -m 600 -o sandbox /e2e/authorized_keys /home/sandbox/.ssh/authorized_keys &&
    install -m 600 /e2e/host_key /etc/ssh/e2e_host_key &&
    exec /usr/sbin/sshd -D -e -o ListenAddress=127.0.0.1:2222 -o HostKey=/etc/ssh/e2e_host_key -o PasswordAuthentication=no \
      -o AllowTcpForwarding=no -o X11Forwarding=no -o AllowAgentForwarding=no' >/dev/null
sshd_up() { "$engine" logs "$beside" 2>&1 | grep -q "Server listening"; }
wait_until "sshd" sshd_up
inside_env=(-e E2E_SSH_PORT=2222 -e "E2E_SSH_KEY=$(cat "$work/client_key")" -e "E2E_SSH_FINGERPRINT=$(ssh-keygen -lf "$work/host_key.pub" | awk '{print $2}')")
