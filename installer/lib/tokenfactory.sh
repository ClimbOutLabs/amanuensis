# shellcheck shell=bash
# Optional hosted model (Nebius Token Factory): the key is read from stdin, kept in shell memory, and written
# only to the instance .env. The app derives its default provider from that file; the installer never calls the API.

# Must equal DEFAULT_TOKEN_FACTORY_MODEL in packages/trueforge/src/runtime/tokenFactoryDefaults.ts (contract test).
TF_DEFAULT_MODEL=nvidia/nemotron-3-super-120b-a12b

valid_tf_key() { matches_whole "$1" '^[A-Za-z0-9._~+/=-]{16,512}$'; }
valid_tf_model() { matches_whole "$1" '^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$'; }
valid_tf_cap() { matches_whole "$1" '^[1-9][0-9]{0,11}$'; }

# The key is never echoed in a message, only its problem.
tf_key_problem() {
  valid_tf_key "$1" || echo "the Token Factory key has a length or characters a key never has"
}

# --token-factory-key-stdin: one line of stdin, read before any prompt so it cannot be taken by one.
read_token_factory_key_stdin() {
  local line=
  IFS= read -r line || true
  [ -n "$line" ] || usage_die "--token-factory-key-stdin got an empty line"
  [ -z "$(tf_key_problem "$line")" ] || usage_die "$(tf_key_problem "$line")"
  AMAN_TF_KEY=$line
}

# Sets I_TF (1 when a hosted model is wanted), I_TF_MODEL and I_TF_CAP. The key comes only from
# --token-factory-key-stdin; nothing asks for it. A dry run never reads the key, so it plans for one when the flag is given.
instance_collect_token_factory() {
  I_TF=0
  I_TF_MODEL=${OPT_TF_MODEL:-}
  I_TF_CAP=${OPT_TF_CAP:-}
  [ -z "$I_TF_MODEL" ] || valid_tf_model "$I_TF_MODEL" || usage_die "--token-factory-model is not a model id"
  [ -z "$I_TF_CAP" ] || valid_tf_cap "$I_TF_CAP" || usage_die "--token-factory-daily-cap must be a whole number of tokens above zero"
  if [ -n "$AMAN_TF_KEY" ] || { [ "$DRY_RUN" = 1 ] && [ "$OPT_TF_KEY_STDIN" = 1 ]; }; then
    I_TF=1
    : "${I_TF_MODEL:=$TF_DEFAULT_MODEL}"
  elif [ -n "$I_TF_MODEL$I_TF_CAP" ]; then
    usage_die "--token-factory-model and --token-factory-daily-cap need a Token Factory key (--token-factory-key-stdin)"
  fi
}

# ---- key rotation on a re-run -------------------------------------------------------------------

TF_ROTATE_NAME=

# The existing instance a key given with --token-factory-key-stdin belongs to: --name, else the only instance, else main.
tf_rotation_name() {
  local names
  if [ -n "${OPT_NAME:-}" ]; then
    printf '%s' "$OPT_NAME"
    return 0
  fi
  names=$(reg_names)
  if [ "$(printf '%s\n' "$names" | wc -l | tr -d ' ')" = 1 ]; then
    printf '%s' "$names"
  elif reg_exists main; then
    printf '%s' main
  else
    usage_die "--token-factory-key-stdin on an existing machine needs --name of the instance whose key changes"
  fi
}

# Reads the new key for an instance that already exists. With --password-stdin its first line is the password, which an
# existing instance has no use for, so it is read and dropped to keep the order of the lines the same as for a new one.
tf_rotation_collect() {
  local name skipped=
  TF_ROTATE_NAME=
  [ "$OPT_TF_KEY_STDIN" = 1 ] || return 0
  name=$(tf_rotation_name)
  [ "$DRY_RUN" != 1 ] || return 0
  if [ "$PASSWORD_FROM_STDIN" = 1 ]; then IFS= read -r skipped || true; fi
  read_token_factory_key_stdin
  TF_ROTATE_NAME=$name
}

# Rewrites NEBIUS_API_KEY inside the managed block of the instance .env; the key only passes through shell builtins.
tf_rotation_write_env() {
  local name=$1 env
  env="$(instance_dir "$name")/.env"
  [ -f "$env" ] || die "instance $name has no .env, so its Token Factory key was not changed"
  grep -q '^# >>> managed by the installer' "$env" || die "the managed block of $env is missing, so its Token Factory key was not changed"
  env_managed_set "$env" NEBIUS_API_KEY "$AMAN_TF_KEY"
}

tf_rotation_apply() {
  local name=$TF_ROTATE_NAME
  [ -n "$name" ] && [ -n "$AMAN_TF_KEY" ] || return 0
  tf_rotation_write_env "$name"
  AMAN_TF_KEY=
  TF_ROTATE_NAME=
  if [ "$(reg_get "$name" token_factory)" != 1 ]; then
    reg_set "$name" token_factory 1
    [ -n "$(reg_get "$name" tf_model)" ] || reg_set "$name" tf_model "$TF_DEFAULT_MODEL"
  fi
  log_event "token factory key replaced for instance $name"
  say "Token Factory key updated; restarting the app"
  dc "$name" up -d --force-recreate --no-deps --wait --wait-timeout 240 app ||
    die "the app of instance $name did not restart healthy with the new key. Look at: docker compose -p aman-$name logs --tail 50 app"
}

tf_plan_detail() {
  local text="The key goes only into the instance .env."
  if [ -n "$I_TF_CAP" ]; then text="$text Capped at $I_TF_CAP tokens per day."; fi
  printf '%s' "$text"
}

# The model row of the summary: a hosted model is the only one chosen at install time; otherwise models are added in the app.
print_model_row() {
  local name=$1 cap
  if [ "$(reg_get "$name" token_factory)" = 1 ]; then
    cap=$(reg_get "$name" tf_cap)
    ui_check_row ok "Model" "Token Factory, $(reg_get "$name" tf_model)${cap:+, limit $cap tokens a day}"
  else
    ui_check_row todo "Model" "not set: add one in Settings $S_PROMPT Models"
  fi
}
