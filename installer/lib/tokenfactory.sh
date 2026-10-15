# shellcheck shell=bash
# Optional hosted model (Nebius Token Factory): the key is read hidden or from stdin, kept in shell memory, and written
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

# Optional hidden prompt, for a person at a terminal only. A pipe never answers it (that is what
# --token-factory-key-stdin is for), so scripted answers to the other prompts keep their order. Enter skips it.
prompt_token_factory_key() {
  local line=
  [ "$ASSUME_YES" != 1 ] && [ "$DRY_RUN" != 1 ] && [ -t 0 ] || return 0
  printf 'Token Factory key (optional, hidden; press Enter to use no hosted model): ' >&2
  IFS= read -rs line || true
  printf '\n' >&2
  [ -n "$line" ] || return 0
  [ -z "$(tf_key_problem "$line")" ] || usage_die "$(tf_key_problem "$line")"
  AMAN_TF_KEY=$line
}

tf_flag_given() { [ "$OPT_TF_KEY_STDIN" = 1 ] || [ -n "$I_TF_MODEL$I_TF_CAP" ]; }

# Sets I_TF (1 when a hosted model is wanted), I_TF_MODEL and I_TF_CAP. A dry run never reads the key, so it
# plans for one whenever a Token Factory flag is given: the real run asks for it at the hidden prompt.
instance_collect_token_factory() {
  I_TF=0
  I_TF_MODEL=${OPT_TF_MODEL:-}
  I_TF_CAP=${OPT_TF_CAP:-}
  [ -z "$I_TF_MODEL" ] || valid_tf_model "$I_TF_MODEL" || usage_die "--token-factory-model is not a model id"
  [ -z "$I_TF_CAP" ] || valid_tf_cap "$I_TF_CAP" || usage_die "--token-factory-daily-cap must be a whole number of tokens above zero"
  if [ -z "$AMAN_TF_KEY" ] && [ "$OPT_TF_KEY_STDIN" != 1 ]; then
    prompt_token_factory_key
  fi
  if [ -n "$AMAN_TF_KEY" ] || { [ "$DRY_RUN" = 1 ] && tf_flag_given; }; then
    I_TF=1
    : "${I_TF_MODEL:=$TF_DEFAULT_MODEL}"
  elif [ -n "$I_TF_MODEL$I_TF_CAP" ]; then
    usage_die "--token-factory-model and --token-factory-daily-cap need a Token Factory key (hidden prompt or --token-factory-key-stdin)"
  fi
}

tf_plan_text() {
  local text="Use Token Factory (model $I_TF_MODEL) as the default model; the key goes only into the instance .env"
  if [ -n "$I_TF_CAP" ]; then text="$text, capped at $I_TF_CAP tokens per day"; fi
  printf '%s' "$text"
}

# Next step for the model, from the registry.
print_model_hint() {
  local name=$1 cap
  if [ "$(reg_get "$name" token_factory)" = 1 ]; then
    cap=$(reg_get "$name" tf_cap)
    say "  Model:    Token Factory, $(reg_get "$name" tf_model), is the default model. Its key is in $(instance_dir "$name")/.env (mode 600)."
    if [ -n "$cap" ]; then
      say "            Daily limit: $cap tokens per day."
    fi
    say "            Check it any time: $(doctor_shim) doctor --instance $name --only model"
    return 0
  fi
  if [ -n "$(reg_get "$name" model_endpoint)" ]; then
    say "  Model:    open Settings > Models and enter $(reg_get "$name" model_endpoint)"
  else
    say "  Model:    not set yet. Next step: open Settings > Models and add your model server address or a provider key."
  fi
  say "            A model server running on this computer must listen on more than 127.0.0.1 to be reachable"
  say "            from the app, which sees this computer as host.docker.internal. Make it listen on all addresses"
  say "            (or on the Docker bridge address), then use http://host.docker.internal:<its port>/v1."
}
