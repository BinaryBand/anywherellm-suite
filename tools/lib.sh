# Shared by the scripts in tools/. Sourced, never run.

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# IMAGE, INNER_PORT and BRIDGE_PORT: the one AnythingLLM every check runs against.
# shellcheck source=/dev/null
. "$ROOT/contract/versions.env"

# skills: the name of each skill under packages/skills, a folder with a plugin.json.
skills() { for c in "$ROOT"/packages/skills/*/plugin.json; do [ -f "$c" ] && basename "$(dirname "$c")"; done; }

# plugin_field <key>: a field of the loaded skill's plugin.json.
plugin_field() { node -p 'require(process.argv[1])[process.argv[2]]' "$SKILL_DIR/plugin.json" "$1"; }

# load_skill <name>: sets SKILL_DIR and HUB_ID for packages/skills/<name>. AnythingLLM finds an
# imported skill by a hubId equal to its folder; build.mjs puts what ships in build/<hubId>.
load_skill() {
  SKILL_DIR="$ROOT/packages/skills/${1:?skill name required (one of: $(skills | tr '\n' ' '))}"
  [ -f "$SKILL_DIR/plugin.json" ] || { echo "no such skill: $1 (one of: $(skills | tr '\n' ' '))" >&2; return 1; }
  HUB_ID=$(plugin_field hubId)
}

# not_yet <script>: the scripts below are stubs until the parts are moved in.
not_yet() { echo "tools/$1: not written yet (the parts have not been moved in)" >&2; exit 1; }

# need_engine: sets engine (podman, else docker) and podman (1 for podman) for the scripts that start a
# container, or stops the script when neither is installed.
need_engine() {
  engine=$(command -v podman || command -v docker) || { echo "${0##*/}: needs podman or docker" >&2; exit 2; }
  podman=$([ "$(basename "$engine")" = podman ] && echo 1 || true)
}

# open_storage: lets the host user change what the container $name's user made (docker only; with
# podman the container's user is the host user).
open_storage() { [ -n "$podman" ] || "$engine" exec -u root "$name" chmod -R a+rwX "$INNER_STORAGE" 2>/dev/null || true; }

# json <expression>: reads JSON on stdin as `j` and prints the expression.
json() { node -e "let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => { const j = JSON.parse(s); console.log($1); });"; }

# free_port: a port nothing listens on now.
free_port() { node -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });'; }

# wait_until <what> <command...>: up to two minutes for the command to succeed.
wait_until() {
  local what=$1
  shift
  for _ in $(seq 1 60); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 2
  done
  echo "${0##*/}: $what did not come up" >&2
  return 1
}
