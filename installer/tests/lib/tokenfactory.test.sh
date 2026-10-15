#!/usr/bin/env bash
# The optional Token Factory key: prompts, stdin, the instance .env, and every place the key must never appear.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

TF_KEY="v1.sentinel-token-factory-key_7f3a91c2"
DEFAULT_MODEL=nvidia/nemotron-3-super-120b-a12b

env_value() { sed -n "s/^$2=//p" "$AMAN_HOME/instances/$1/.env" | head -n 1; }

# Fails when the key is in any file under the home other than the instance .env, or in anything the run printed.
assert_key_only_in_env() {
  local found
  found=$(grep -rIl -- "$TF_KEY" "$AMAN_HOME" "$SB/stub.log" 2>/dev/null | sort | tr '\n' ' ' || true)
  assert_eq "$found" "$AMAN_HOME/instances/main/.env " "files holding the key"
  assert_not_contains "$OUT" "$TF_KEY" "stdout"
  assert_not_contains "$ERR" "$TF_KEY" "stderr"
}

install_with_key_stdin() {
  with_input "$SENTINEL_PASSWORD
$TF_KEY
"
  run_install --yes --password-stdin --token-factory-key-stdin --email owner@example.invalid "$@"
  clear_input
}

test_key_from_stdin_reaches_only_the_env() {
  t_begin "the key read from stdin is written to the instance .env (0600) and nowhere else"
  sandbox_new
  install_with_key_stdin
  assert_rc 0
  assert_eq "$(env_value main NEBIUS_API_KEY)" "$TF_KEY"
  assert_eq "$(env_value main TOKEN_FACTORY_MODEL)" "$DEFAULT_MODEL"
  assert_eq "$(env_value main TOKEN_FACTORY_DAILY_TOKEN_CAP)" "" "no cap unless asked for"
  assert_mode "$AMAN_HOME/instances/main/.env" 600
  assert_key_only_in_env
  assert_tree_lacks "$AMAN_HOME" "$SENTINEL_PASSWORD"
  assert_contains "$OUT" "Token Factory, $DEFAULT_MODEL, is the default model"
  assert_contains "$OUT" "doctor --instance main --only model"
  assert_not_contains "$OUT" "Settings > Models" "the generic model hint is replaced"
  sandbox_drop
}

test_model_and_cap_flags() {
  t_begin "--token-factory-model and --token-factory-daily-cap are written to the managed block"
  sandbox_new
  install_with_key_stdin --token-factory-model vendor/other-model:fast --token-factory-daily-cap 250000
  assert_rc 0
  assert_eq "$(env_value main TOKEN_FACTORY_MODEL)" "vendor/other-model:fast"
  assert_eq "$(env_value main TOKEN_FACTORY_DAILY_TOKEN_CAP)" 250000
  local env managed
  env=$(cat "$AMAN_HOME/instances/main/.env")
  managed=${env%%# <<< end of managed block*}
  assert_contains "$managed" "NEBIUS_API_KEY=$TF_KEY" "inside the managed block"
  assert_contains "$managed" "TOKEN_FACTORY_DAILY_TOKEN_CAP=250000"
  assert_contains "$OUT" "Daily limit: 250000 tokens per day"
  assert_key_only_in_env
  sandbox_drop
}

test_password_first_then_key_on_stdin() {
  t_begin "with both stdin flags the password is the first line and the key the second"
  sandbox_new
  with_input "$SENTINEL_PASSWORD
$TF_KEY
"
  run_install --yes --password-stdin --token-factory-key-stdin --email owner@example.invalid
  clear_input
  assert_rc 0
  assert_eq "$(cat "$SB_STATE/hash_stdin")" "$SENTINEL_PASSWORD" "the password line reached the hashing step"
  assert_eq "$(env_value main NEBIUS_API_KEY)" "$TF_KEY"
  sandbox_drop
}

test_key_is_never_taken_from_argv() {
  t_begin "a key on the command line is refused without being printed"
  sandbox_new
  local form
  for form in "--token-factory-key=$TF_KEY" "--token-factory-key"; do
    with_input "$SENTINEL_PASSWORD
"
    run_install --yes --password-stdin --email owner@example.invalid "$form" "$TF_KEY"
    clear_input
    assert_rc 2
    assert_contains "$ERR" "never taken from the command line"
    assert_not_contains "$ERR" "$TF_KEY"
    assert_not_contains "$OUT" "$TF_KEY"
  done
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_key_in_the_callers_environment_is_ignored() {
  t_begin "NEBIUS_API_KEY and AMAN_TF_KEY in the caller's environment are not used"
  sandbox_new
  build_run_env
  with_input "$SENTINEL_PASSWORD
"
  set +e
  env -i "${RUN_ENV[@]}" NEBIUS_API_KEY="$TF_KEY" AMAN_TF_KEY="$TF_KEY" bash "$SB_INSTALLER/install.sh" --yes --password-stdin --email owner@example.invalid <"$INPUT_FILE" >"$SB/out" 2>"$SB/err"
  RC=$?
  set -e
  clear_input
  assert_rc 0
  assert_eq "$(env_value main NEBIUS_API_KEY)" "" "no key was written"
  assert_tree_lacks "$AMAN_HOME" "$TF_KEY"
  assert_contains "$(cat "$SB/out")" "not set yet"
  sandbox_drop
}

test_hidden_prompt_on_a_terminal() {
  t_begin "the key typed at the prompt is not echoed, is written to the .env, and replaces the model server question"
  sandbox_new
  run_install_tty "Instance name=>
Owner email=>owner@example.invalid
Address you will use=>
Token Factory key=>$TF_KEY
Go ahead?=>y
Password for the owner account=>$SENTINEL_PASSWORD
Repeat the password=>$SENTINEL_PASSWORD"
  assert_eq "$RC" 0
  assert_contains "$OUT" "Token Factory key (optional, hidden"
  assert_not_contains "$OUT" "$TF_KEY" "the terminal never shows the key"
  assert_not_contains "$OUT" "Model server address" "a hosted model replaces that question"
  assert_contains "$OUT" "Use Token Factory (model $DEFAULT_MODEL) as the default model"
  assert_eq "$(env_value main NEBIUS_API_KEY)" "$TF_KEY"
  assert_tree_lacks "$SB/stub.log" "$TF_KEY"
  sandbox_drop
}

test_the_echo_test_can_fail() {
  t_begin "the same run echoes the key if the prompt stops using read -s"
  sandbox_new
  sed -i 's/IFS= read -rs line/IFS= read -r line/' "$SB_INSTALLER/lib/tokenfactory.sh"
  assert_not_contains "$(cat "$SB_INSTALLER/lib/tokenfactory.sh")" "read -rs"
  run_install_tty "Instance name=>
Owner email=>owner@example.invalid
Address you will use=>
Token Factory key=>$TF_KEY
Go ahead?=>y
Password for the owner account=>$SENTINEL_PASSWORD
Repeat the password=>$SENTINEL_PASSWORD"
  assert_contains "$OUT" "$TF_KEY" "echo is visible without -s"
  sandbox_drop
}

test_enter_skips_the_key() {
  t_begin "pressing Enter at the key prompt keeps the model server question and writes no key"
  sandbox_new
  run_install_tty "Instance name=>
Owner email=>owner@example.invalid
Address you will use=>
Token Factory key=>
Model server address=>
Go ahead?=>y
Password for the owner account=>$SENTINEL_PASSWORD
Repeat the password=>$SENTINEL_PASSWORD"
  assert_eq "$RC" 0
  assert_contains "$OUT" "Model server address"
  assert_eq "$(env_value main NEBIUS_API_KEY)" ""
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/.env")" "TOKEN_FACTORY"
  assert_contains "$OUT" "not set yet. Next step: open Settings > Models"
  sandbox_drop
}

test_yes_and_pipes_never_wait_for_the_key() {
  t_begin "--yes, and a piped stdin without the stdin flag, skip the key prompt"
  sandbox_new
  install_machine
  assert_not_contains "$ERR" "Token Factory key"
  assert_eq "$(env_value main NEBIUS_API_KEY)" ""
  sandbox_drop
}

test_model_endpoint_still_works_next_to_a_key() {
  t_begin "an explicit --model-endpoint is kept next to the hosted model"
  sandbox_new
  install_with_key_stdin --model-endpoint http://host.docker.internal:11434/v1
  assert_rc 0
  assert_eq "$(sed -n 's/^model_endpoint=//p' "$AMAN_HOME/state/instances/main.conf")" "http://host.docker.internal:11434/v1"
  assert_eq "$(env_value main NEBIUS_API_KEY)" "$TF_KEY"
  sandbox_drop
}

test_flags_without_a_key_are_refused() {
  t_begin "a model or cap without a key is a usage error that names the ways to give one"
  sandbox_new
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid --token-factory-model vendor/m
  clear_input
  assert_rc 2
  assert_contains "$ERR" "need a Token Factory key"
  assert_contains "$ERR" "--token-factory-key-stdin"
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_bad_values_are_refused_without_echoing_the_key() {
  t_begin "bad key, model and cap values are refused; the key is never quoted back"
  sandbox_new
  with_input "$SENTINEL_PASSWORD
short key
"
  run_install --yes --password-stdin --token-factory-key-stdin --email owner@example.invalid
  clear_input
  assert_rc 2
  assert_contains "$ERR" "length or characters a key never has"
  assert_not_contains "$ERR" "short key"
  with_input "$SENTINEL_PASSWORD

"
  run_install --yes --password-stdin --token-factory-key-stdin --email owner@example.invalid
  clear_input
  assert_rc 2
  assert_contains "$ERR" "--token-factory-key-stdin got an empty line"
  install_with_key_stdin --token-factory-model 'bad model'
  assert_rc 2
  install_with_key_stdin --token-factory-model '-leading'
  assert_rc 2
  assert_contains "$ERR" "not a model id"
  install_with_key_stdin --token-factory-daily-cap 0
  assert_rc 2
  assert_contains "$ERR" "whole number of tokens above zero"
  install_with_key_stdin --token-factory-daily-cap 12x
  assert_rc 2
  assert_not_contains "$ERR$OUT" "$TF_KEY"
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_dry_run_plans_without_reading_or_printing_the_key() {
  t_begin "a dry run states the plan, leaves stdin alone and never prints a key"
  sandbox_new
  with_input "$TF_KEY
"
  run_install --dry-run --token-factory-key-stdin --token-factory-model vendor/m --token-factory-daily-cap 1000 --email owner@example.invalid
  clear_input
  assert_rc 0
  assert_contains "$OUT" "Use Token Factory (model vendor/m) as the default model; the key goes only into the instance .env, capped at 1000 tokens per day"
  assert_not_contains "$OUT$ERR" "$TF_KEY"
  assert_no_path "$AMAN_HOME"
  sandbox_drop
}

test_a_dry_run_without_tf_flags_has_no_tf_line() {
  t_begin "the plan has no Token Factory line unless one is asked for"
  sandbox_new
  run_install --dry-run --email owner@example.invalid
  assert_rc 0
  assert_not_contains "$OUT" "Token Factory"
  sandbox_drop
}

test_network_list_names_token_factory() {
  t_begin "--print-network lists the Token Factory host"
  sandbox_new
  run_install --print-network
  assert_rc 0
  assert_contains "$OUT" "api.tokenfactory.nebius.com"
  sandbox_drop
}

test_instance_add_takes_a_key() {
  t_begin "a second instance gets its own key in its own .env"
  sandbox_new
  install_machine
  with_input "$SENTINEL_PASSWORD
$TF_KEY
"
  run_install instance add second --yes --password-stdin --token-factory-key-stdin --email second@example.invalid --token-factory-daily-cap 5000
  clear_input
  assert_rc 0
  assert_eq "$(env_value second NEBIUS_API_KEY)" "$TF_KEY"
  assert_eq "$(env_value second TOKEN_FACTORY_DAILY_TOKEN_CAP)" 5000
  assert_eq "$(env_value main NEBIUS_API_KEY)" "" "the first instance is untouched"
  assert_not_contains "$OUT$ERR" "$TF_KEY"
  sandbox_drop
}

test_rerun_does_not_rewrite_the_env() {
  t_begin "a second run leaves the written key and model as they are"
  sandbox_new
  install_with_key_stdin --token-factory-model vendor/m
  local before
  before=$(cat "$AMAN_HOME/instances/main/.env")
  install_machine
  assert_eq "$(cat "$AMAN_HOME/instances/main/.env")" "$before"
  sandbox_drop
}

test_key_from_stdin_reaches_only_the_env
test_model_and_cap_flags
test_password_first_then_key_on_stdin
test_key_is_never_taken_from_argv
test_key_in_the_callers_environment_is_ignored
test_hidden_prompt_on_a_terminal
test_the_echo_test_can_fail
test_enter_skips_the_key
test_yes_and_pipes_never_wait_for_the_key
test_model_endpoint_still_works_next_to_a_key
test_flags_without_a_key_are_refused
test_bad_values_are_refused_without_echoing_the_key
test_dry_run_plans_without_reading_or_printing_the_key
test_a_dry_run_without_tf_flags_has_no_tf_line
test_network_list_names_token_factory
test_instance_add_takes_a_key
test_rerun_does_not_rewrite_the_env
tests_finish
