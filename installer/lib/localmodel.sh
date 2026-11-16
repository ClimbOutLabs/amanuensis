# shellcheck shell=bash
# The local model bridge, an optional way to reach a model server on this computer: an instance reaches it over
# plumbing of its own, at http://aman-local-model:PORT, instead of at one of this computer's network addresses. Those
# addresses still work for a model, but they can stop answering the instance's containers after a network change, such
# as an update to Tailscale, and a model that listens only on 127.0.0.1 never answers at them at all. The owner names
# each port with aman local-model; the instance carries only those ports. Needs lib/registry.sh, lib/shared.sh and
# lib/tls.sh.

# The ports an instance's bridge carries, comma-separated, in the order they were added.
local_model_ports() { reg_get "$1" local_models; }

# The port of an endpoint on this computer, given as PORT, 127.0.0.1:PORT or localhost:PORT. Prints nothing when the
# endpoint is not one, so the caller can say why.
local_model_endpoint_port() {
  local endpoint=$1 port
  case "$endpoint" in
    127.0.0.1:* | localhost:*) port=${endpoint#*:} ;;
    *:*) return 0 ;;
    *) port=$endpoint ;;
  esac
  [[ $port =~ ^[1-9][0-9]{3,4}$ ]] || return 0
  [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || return 0
  printf '%s' "$port"
}

# The bridge needs the instance's containers and this shell to see the same computer. On Windows the installer runs in
# a container of its own (its home is the state volume), so this computer's addresses are not the ones it would see.
local_model_bridge_available() { [ "$AMAN_HOME" != "$VOLUME_HOME" ]; }

# Docker on this computer's own kernel: the host side shares this computer's network and dials 127.0.0.1. Under Docker
# Desktop it dials host.docker.internal, which Docker Desktop points at this computer, loopback included.
local_model_host_network() {
  local os=''
  [ "$(uname -s)" = Linux ] || return 1
  if docker_available_for_probes; then os=$(D info --format '{{.OperatingSystem}}' 2>/dev/null || true); fi
  case "$os" in *[Dd]ocker\ [Dd]esktop*) return 1 ;; esac
  return 0
}

# The template values for an instance's compose file, as KEY=value arguments for render_template.
local_model_render_args() { # name
  local name=$1 ports on=0 hostnet=0 desktop=0 target=''
  ports=$(local_model_ports "$name")
  if local_model_bridge_available && [ -n "$ports" ]; then
    on=1
    if local_model_host_network; then
      hostnet=1
      target=127.0.0.1
    else
      desktop=1
      target=host.docker.internal
    fi
  fi
  printf '%s\n' "IF_LOCAL_MODEL=$on" "LOCAL_MODEL_PORTS=$ports" \
    "IF_LOCAL_MODEL_HOSTNET=$hostnet" "IF_LOCAL_MODEL_DESKTOP=$desktop" "LOCAL_MODEL_TARGET=$target"
}

# The bridge script sits beside the compose file, which mounts it read-only into both sides.
local_model_files() { # instance dir
  write_if_changed "$1/local-model-bridge.mjs" 644 <"$REPO_ROOT/ops/compose/local-model/bridge.mjs" || true
}

# The app refuses every address on the instance's own networks, the bridge's among them, unless its exact host:port is
# in LOCAL_MODEL_ENDPOINTS. That line is the owner's, below the managed block, so the bridge's entry is added to it or
# taken out of it and every other entry stays as it was. Only the last line Compose reads for the key changes, in
# place; with none outside the managed block, a line is added at the end. A list left empty drops the line.
local_model_endpoints_update() { # env file, port, add|remove
  local env=$1 mode=$3 entry=aman-local-model:$2 old part parts=() list='' lower
  [ -f "$env" ] || die "The settings file $env is missing. Run: aman doctor instance --fix"
  old=$(env_get "$env" LOCAL_MODEL_ENDPOINTS)
  [ -z "$old" ] || IFS=, read -r -a parts <<<"$old"
  for part in ${parts[@]+"${parts[@]}"}; do
    part=${part#"${part%%[![:space:]]*}"}
    part=${part%"${part##*[![:space:]]}"}
    [ -n "$part" ] || continue
    lower=$(lowercase "$part")
    [ "$lower" != "$entry" ] || continue
    list=${list:+$list,}$part
  done
  if [ "$mode" = add ]; then list=${list:+$list,}$entry; fi
  [ "$list" != "$old" ] || return 0
  LC_ALL=C awk -v re="$(env_key_line_re LOCAL_MODEL_ENDPOINTS)" -v list="$list" '
    { lines[NR] = $0 }
    /^# >>> managed by the installer/ { inblock = 1 }
    $0 ~ re { last = inblock ? 0 : NR }
    /^# <<< end of managed block/ { inblock = 0 }
    END {
      for (i = 1; i <= NR; i++) {
        if (i != last) print lines[i]
        else if (list != "") print "LOCAL_MODEL_ENDPOINTS=" list
      }
      if (last == 0 && list != "") print "LOCAL_MODEL_ENDPOINTS=" list
    }' "$env" | write_if_changed "$env" 600 || true
}

# aman local-model PORT [--remove]: adds a port of this computer to an instance's bridge, or takes it away, then starts
# the instance again with it.
cmd_instance_local_model() {
  local name=${OPT_NAME:-} endpoint=${OPT_LOCAL_MODEL:-} port ports list='' p
  [ -n "$name" ] && [ -n "$endpoint" ] || usage_die "usage: install.sh instance local-model <name> <port> [--remove]"
  valid_name "$name" || usage_die "$(name_problem "$name")"
  reg_exists "$name" || die "Instance $name does not exist."
  port=$(local_model_endpoint_port "$endpoint")
  [ -n "$port" ] ||
    usage_die "$endpoint is not a port on this computer. Give the port your model server listens on, from 1024 to 65535, for example: aman local-model 11434"
  local_model_bridge_available ||
    die "The local model bridge is not available in this install yet. In Settings, give the model the address http://host.docker.internal:$port/v1 instead."
  require_installed
  docker_prepare
  lock_acquire
  load_installed_release
  warn_if_installed_older
  # An app image built before the bridge has no folder for its socket files, and the bridge would not start.
  if [ "$OPT_REMOVE" != 1 ] && ! D run --rm --network none --entrypoint test "$REL_APP_TAG" -d /run/aman-local-model >/dev/null 2>&1; then
    die "The installed Aman is older than the local model bridge, so nothing changed. Run aman upgrade, then run this command again."
  fi
  ports=$(local_model_ports "$name")
  if [ "$OPT_REMOVE" = 1 ]; then
    case ",$ports," in *",$port,"*) ;; *) die "Instance $name does not carry port $port. Nothing changed." ;; esac
    for p in ${ports//,/ }; do
      [ "$p" = "$port" ] || list=${list:+$list,}$p
    done
    if [ -n "$list" ]; then reg_set "$name" local_models "$list"; else reg_unset "$name" local_models; fi
    local_model_endpoints_update "$(instance_dir "$name")/.env" "$port" remove
  else
    case ",$ports," in
      *",$port,"*) ;;
      *) reg_set "$name" local_models "${ports:+$ports,}$port" ;;
    esac
    local_model_endpoints_update "$(instance_dir "$name")/.env" "$port" add
  fi
  instance_render "$name" "$REL_APP_TAG" "$REL_DEX_IMAGE"
  instance_up "$name" recreate
  say "Aman started again, so the change is in use now."
  if [ "$OPT_REMOVE" = 1 ]; then
    ui_ok "Instance $name no longer carries port $port of this computer."
  else
    ui_ok "Instance $name reaches the model at port $port of this computer."
    say "In Settings, Models, give the model the address http://aman-local-model:$port/v1"
  fi
}
