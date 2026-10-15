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

test_dry_run_with_only_model_flags_plans_for_the_prompt() {
  t_begin "a dry run with a model flag and no key flag still plans Token Factory (the real run asks at the prompt)"
  sandbox_new
  run_install --dry-run --token-factory-model vendor/m --email owner@example.invalid
  assert_rc 0
  assert_contains "$OUT" "Use Token Factory (model vendor/m) as the default model"
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

NEW_KEY="v1.sentinel-rotated-key_5b2e08d4"

# The files under the home and the run's output must not hold a key; the .env holds exactly the other one.
assert_rotated() {
  assert_eq "$(env_value "${1:-main}" NEBIUS_API_KEY)" "$NEW_KEY" "the new key is in the .env"
  assert_tree_lacks "$AMAN_HOME" "$TF_KEY"
  assert_tree_lacks "$SB/stub.log" "$NEW_KEY"
  assert_not_contains "$OUT$ERR" "$NEW_KEY"
  assert_not_contains "$OUT$ERR" "$TF_KEY"
}

test_a_key_on_a_rerun_replaces_the_old_one() {
  t_begin "a new key on stdin for an existing instance is written in place (0600), the app restarts, nothing else moves"
  sandbox_new
  install_with_key_stdin --token-factory-model vendor/m --token-factory-daily-cap 5000
  assert_rc 0
  printf 'MY_OWN_SETTING=kept\n' >>"$AMAN_HOME/instances/main/.env"
  local before_lines
  before_lines=$(grep -vc '^NEBIUS_API_KEY=' "$AMAN_HOME/instances/main/.env")
  : >"$STUB_LOG"
  with_input "$NEW_KEY
"
  run_install --yes --token-factory-key-stdin
  clear_input
  assert_rc 0
  assert_contains "$OUT" "Token Factory key updated; restarting the app"
  assert_rotated main
  assert_mode "$AMAN_HOME/instances/main/.env" 600
  assert_eq "$(grep -vc '^NEBIUS_API_KEY=' "$AMAN_HOME/instances/main/.env")" "$before_lines" "every other line is unchanged"
  assert_eq "$(env_value main TOKEN_FACTORY_MODEL)" vendor/m
  assert_eq "$(env_value main TOKEN_FACTORY_DAILY_TOKEN_CAP)" 5000
  assert_eq "$(env_value main MY_OWN_SETTING)" kept "a line below the managed block"
  assert_eq "$(grep -c '^NEBIUS_API_KEY=' "$AMAN_HOME/instances/main/.env")" 1
  assert_not_contains "$(dir_names "$AMAN_HOME/instances/main")" ".env." "no temporary file is left"
  assert_log_has "up -d --force-recreate --no-deps --wait --wait-timeout 240 app"
  assert_contains "$(grep 'force-recreate' "$STUB_LOG")" "aman-main"
  sandbox_drop
}

test_a_key_on_a_rerun_with_the_password_line() {
  t_begin "with --password-stdin too the first line is the password, which an existing instance drops, and the second the key"
  sandbox_new
  install_with_key_stdin
  with_input "$SENTINEL_PASSWORD
$NEW_KEY
"
  run_install --yes --password-stdin --token-factory-key-stdin --email owner@example.invalid
  clear_input
  assert_rc 0
  assert_rotated main
  assert_tree_lacks "$AMAN_HOME" "$SENTINEL_PASSWORD"
  sandbox_drop
}

test_a_key_for_a_named_instance() {
  t_begin "instance add on an existing name replaces that instance's key and leaves the others alone"
  sandbox_new
  install_with_key_stdin
  with_input "$SENTINEL_PASSWORD
$TF_KEY
"
  run_install instance add second --yes --password-stdin --token-factory-key-stdin --email second@example.invalid
  clear_input
  assert_rc 0
  with_input "$NEW_KEY
"
  run_install instance add second --yes --token-factory-key-stdin
  clear_input
  assert_rc 0
  assert_contains "$OUT" "Token Factory key updated; restarting the app"
  assert_eq "$(env_value second NEBIUS_API_KEY)" "$NEW_KEY"
  assert_eq "$(env_value main NEBIUS_API_KEY)" "$TF_KEY" "the other instance is untouched"
  assert_not_contains "$OUT$ERR" "$NEW_KEY"
  sandbox_drop
}

test_a_key_for_an_instance_that_had_none() {
  t_begin "a key for an instance installed without one is added to its managed block and recorded"
  sandbox_new
  install_machine
  with_input "$NEW_KEY
"
  run_install --yes --token-factory-key-stdin
  clear_input
  assert_rc 0
  assert_eq "$(env_value main NEBIUS_API_KEY)" "$NEW_KEY"
  assert_eq "$(sed -n '/^# >>> managed/,/^# <<< end/p' "$AMAN_HOME/instances/main/.env" | grep -c '^NEBIUS_API_KEY=')" 1 "inside the managed block"
  assert_eq "$(sed -n 's/^token_factory=//p' "$AMAN_HOME/state/instances/main.conf")" 1
  assert_eq "$(sed -n 's/^tf_model=//p' "$AMAN_HOME/state/instances/main.conf")" "$DEFAULT_MODEL"
  assert_not_contains "$OUT$ERR" "$NEW_KEY"
  assert_tree_lacks "$SB/stub.log" "$NEW_KEY"
  sandbox_drop
}

test_a_rerun_key_is_checked_and_planned() {
  t_begin "a bad key on a rerun is refused unquoted, a dry run plans the change without reading it, several instances need a name"
  sandbox_new
  install_with_key_stdin
  local before name
  before=$(cat "$AMAN_HOME/instances/main/.env")
  with_input "short key
"
  run_install --yes --token-factory-key-stdin
  clear_input
  assert_rc 2
  assert_contains "$ERR" "length or characters a key never has"
  assert_not_contains "$ERR" "short key"
  assert_eq "$(cat "$AMAN_HOME/instances/main/.env")" "$before"
  with_input "$NEW_KEY
"
  run_install --dry-run --token-factory-key-stdin
  clear_input
  assert_rc 0
  assert_contains "$OUT" "Replace the Token Factory key of instance main"
  assert_eq "$(cat "$AMAN_HOME/instances/main/.env")" "$before" "a dry run changes nothing"
  assert_not_contains "$OUT$ERR" "$NEW_KEY"
  for name in second third; do
    with_input "$SENTINEL_PASSWORD
"
    run_install instance add "$name" --yes --password-stdin --email "$name@example.invalid"
    clear_input
  done
  run_install instance remove main --yes
  with_input "$NEW_KEY
"
  run_install --yes --token-factory-key-stdin
  clear_input
  assert_rc 2
  assert_contains "$ERR" "needs --name of the instance whose key changes" "two instances, none called main"
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
test_dry_run_with_only_model_flags_plans_for_the_prompt
test_a_dry_run_without_tf_flags_has_no_tf_line
test_network_list_names_token_factory
test_instance_add_takes_a_key
test_rerun_does_not_rewrite_the_env
test_a_key_on_a_rerun_replaces_the_old_one
test_a_key_on_a_rerun_with_the_password_line
test_a_key_for_a_named_instance
test_a_key_for_an_instance_that_had_none
test_a_rerun_key_is_checked_and_planned
tests_finish
