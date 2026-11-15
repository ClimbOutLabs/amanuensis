# shellcheck shell=bash
# aman address: the addresses and names an instance answers at besides the ones it finds by itself. A plain address or
# name joins the instance's own list: Aman listens there when it is an address of this computer, on a VPN link too, and
# puts it on the https certificate. A full address (https://name) is a forward: another program, such as Tailscale
# serve or a web server, takes visitors there and passes them on to the app at 127.0.0.1, so sign-in only has to know
# the name. Needs lib/network.sh and lib/instance.sh.

# A forward as one canonical origin: lowercase, no path, no default port. The app and the sign-in service compare the
# same text, so both must see it written the same way.
forward_origin() { # address
  local value scheme rest host port LC_ALL=C
  value=$(lowercase "$1")
  value=${value%/}
  scheme=${value%%://*}
  rest=${value#*://}
  host=${rest%%:*}
  port=
  case "$rest" in *:*) port=${rest#*:} ;; esac
  if { [ "$scheme" = https ] && [ "$port" = 443 ]; } || { [ "$scheme" = http ] && [ "$port" = 80 ]; }; then port=; fi
  printf '%s://%s%s' "$scheme" "$host" "${port:+:$port}"
}

# Why a full address cannot be a forward, as one sentence, or nothing when it is fine. Plain http is only for private
# addresses and names; any name can take https, because the program in front of Aman then encrypts the connection.
forward_problem() { # address
  local value scheme rest host port LC_ALL=C
  value=$(lowercase "$1")
  value=${value%/}
  if ! [[ $value =~ ^(https?)://([a-z0-9.-]+)(:([0-9]{1,5}))?$ ]]; then
    echo "$1 is not a full address. Examples: https://aman.example.ts.net or http://192.168.1.20:8080"
    return
  fi
  scheme=${BASH_REMATCH[1]}
  host=${BASH_REMATCH[2]}
  port=${BASH_REMATCH[4]}
  rest=$(address_problem "$host")
  if [ -n "$port" ] && { [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; }; then
    echo "$1 has a port that is not between 1 and 65535."
  elif [[ $host =~ ^[0-9.]+$ ]]; then
    if ! valid_ipv4 "$host" || ! listenable_ipv4 "$host"; then
      echo "$1 is not a private address. Aman only takes visitors from a private network this way."
    fi
  elif [ -n "$rest" ] && [ "$scheme" = http ]; then
    echo "$1 uses plain http on a name that can be reached from the internet, which is not safe for signing in. Use https."
  elif [ -n "$rest" ] && ! [[ $host =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
    echo "$1 is not an address or a name. Examples: https://aman.example.ts.net or http://192.168.1.20:8080"
  fi
}

# The usage line of the command, with the name the owner types.
address_usage() { echo "usage: aman address list | add <address> | remove <address>"; }

cmd_instance_address() {
  local name=${OPT_NAME:-} action=${OPT_ADDRESS_ACTION:-} value=${OPT_ADDRESS_VALUE:-} problem kind list item new='' found=0 port
  [ -n "$name" ] && [ -n "$action" ] || usage_die "$(address_usage)"
  valid_name "$name" || usage_die "$(name_problem "$name")"
  reg_exists "$name" || die "Instance $name does not exist."
  case "$action" in
    list)
      [ -z "$value" ] || usage_die "$(address_usage)"
      address_list "$name"
      return
      ;;
    add | remove) [ -n "$value" ] || usage_die "$(address_usage)" ;;
    *) usage_die "$(address_usage)" ;;
  esac
  is_loopback_origin "$(reg_get "$name" public_url)" ||
    die "Instance $name has a public address, so its addresses are set with --public-url instead. Nothing changed."
  case "$value" in
    *://*)
      kind=forward
      problem=$(forward_problem "$value")
      [ -z "$problem" ] || usage_die "$problem"
      value=$(forward_origin "$value")
      list=$(reg_get "$name" forwards)
      ;;
    *)
      kind=host
      problem=$(address_problem "$value")
      [ -z "$problem" ] || usage_die "$problem"
      value=$(lowercase "$value")
      list=$(reg_get "$name" extra_hosts)
      if [ "$action" = add ] && [ -z "$(reg_get "$name" origins)" ]; then
        die "Instance $name only answers on this computer, so Aman does not listen at $value. To let another program pass visitors on to it, add that program's full address, for example: aman address add https://$value"
      fi
      ;;
  esac
  for item in ${list//,/ }; do
    if [ "$item" = "$value" ]; then
      found=1
    else
      new="${new:+$new }$item"
    fi
  done
  if [ "$action" = add ]; then
    if [ "$found" = 1 ]; then
      ui_ok "Instance $name already answers at $value. Nothing changed."
      return
    fi
    new="${new:+$new }$value"
  elif [ "$found" = 0 ]; then
    die "$value is not an address you added to instance $name. Run aman address list to see them. Nothing changed."
  fi
  require_installed
  docker_prepare
  lock_acquire
  load_installed_release
  warn_if_installed_older
  if [ "$kind" = forward ]; then
    reg_set "$name" forwards "${new// /,}"
    env_managed_set "$(instance_dir "$name")/.env" ALLOWED_ORIGINS "$(instance_allowed_origins "$name")"
  else
    reg_set "$name" extra_hosts "$new"
    OPT_ADDRESSES=
    instance_apply_addresses "$name" refresh "$REL_APP_TAG"
  fi
  instance_render "$name" "$REL_APP_TAG" "$REL_DEX_IMAGE"
  instance_up "$name" recreate
  log_event "instance $name address $action $value"
  if [ "$action" = remove ]; then
    ui_ok "Instance $name no longer answers at $value."
  elif [ "$kind" = forward ]; then
    port=$(reg_get "$name" app_port)
    ui_ok "Instance $name now lets you sign in at $value."
    say "Set the program in front of Aman to pass visitors on to http://127.0.0.1:$port. Aman answers there on this computer only."
  elif valid_ipv4 "$value" && ! network_own_ipv4 "$value"; then
    ui_ok "Instance $name now lets you sign in at $value."
    say "This computer does not have the address $value, so Aman does not listen there. Devices reach it only if something passes them on to this computer."
  else
    ui_ok "Instance $name now answers at $value."
  fi
}

# Every address an instance answers at, one per line, then the ones its owner added.
address_list() { # name
  local name=$1 allowed forwards item
  allowed=$(instance_allowed_origins "$name")
  if [ -n "$allowed" ]; then origins_display_order "$allowed"; else reg_get "$name" public_url; fi
  forwards=$(reg_get "$name" forwards)
  for item in $(reg_get "$name" extra_hosts) ${forwards//,/ }; do
    printf 'Added by you: %s\n' "$item"
  done
}
