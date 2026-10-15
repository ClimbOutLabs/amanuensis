#!/usr/bin/env bash
# Plain wording, the password rules, the model hint, the disk check and the table layout.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

test_docker_data_disk_is_checked() {
  t_begin "free space is checked on the disk holding Docker's data, not only the install home"
  sandbox_new
  mkdir -p "$SB/dockerroot"
  STUB_DOCKER_ROOT=$SB/dockerroot
  STUB_DOCKER_ROOT_KB=1000000
  run_install --dry-run
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "Less than 10 GB free on the disk holding Docker's data ($SB/dockerroot)"
  STUB_DOCKER_ROOT_KB=50000000
  run_install --dry-run
  assert_rc 0
  STUB_DOCKER_ROOT=$SB/no-such-directory
  STUB_DOCKER_ROOT_KB=1000
  run_install --dry-run
  assert_rc 0
  sandbox_drop
}

test_docker_memory_is_checked() {
  t_begin "Docker memory under 6 GB blocks, 6 to 8 GB warns, 16 GB is quiet"
  sandbox_new
  STUB_DOCKER_MEM_BYTES=4294967296
  run_install --dry-run
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "Docker has only 4.0 GB of memory and needs at least 6 GB to build the app"
  assert_flat_contains "$OUT$ERR" "Settings, Resources, Memory"
  assert_flat_contains "$OUT$ERR" "add swap"
  STUB_DOCKER_MEM_BYTES=7516192768
  run_install --dry-run
  assert_rc 0
  assert_flat_contains "$OUT$ERR" "Docker has 7.0 GB of memory"
  assert_flat_contains "$OUT$ERR" "8 GB or more is recommended"
  STUB_DOCKER_MEM_BYTES=17179869184
  run_install --dry-run
  assert_rc 0
  assert_flat_contains "$OUT$ERR" "Docker has 16 GB of memory"
  assert_not_contains "$OUT$ERR" "recommended" "plenty of memory is quiet"
  sandbox_drop
}

test_out_of_memory_build_points_at_docker_memory() {
  t_begin "a build killed with exit 137 says to raise Docker's memory"
  sandbox_new
  STUB_BUILD_OOM=1
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  assert_rc 1
  assert_flat_contains "$ERR" "ran out of memory"
  assert_flat_contains "$ERR" "Settings, Resources, Memory"
  clear_input
  sandbox_drop
}

test_password_length_is_checked_up_front() {
  t_begin "a password over 72 bytes is refused before anything is built"
  sandbox_new
  local long72 long73 wide
  long72=$(printf 'a%.0s' $(seq 1 72))
  long73=$(printf 'a%.0s' $(seq 1 73))
  wide=$(printf 'é%.0s' $(seq 1 40))
  with_input "$long73
"
  run_install --yes --password-stdin --email owner@example.invalid
  assert_rc 2
  assert_flat_contains "$ERR" "at most 72 bytes"
  assert_log_lacks "docker build"
  assert_no_path "$AMAN_HOME/state/instances"
  with_input "$wide
"
  run_install --yes --password-stdin --email owner@example.invalid
  assert_rc 2
  assert_flat_contains "$ERR" "at most 72 bytes"
  with_input "$long72
"
  run_install --yes --password-stdin --email owner@example.invalid
  assert_rc 0
  assert_eq "$(cat "$SB_STATE/hash_stdin")" "$long72"
  clear_input
  sandbox_drop
}

test_password_stdin_is_read_before_any_prompt() {
  t_begin "--password-stdin takes the first line, so later prompts cannot receive it"
  sandbox_new
  with_input "$SENTINEL_PASSWORD
main
owner@example.invalid


y
"
  run_install --password-stdin
  clear_input
  assert_rc 0
  assert_eq "$(cat "$SB_STATE/hash_stdin")" "$SENTINEL_PASSWORD"
  assert_contains "$(cat "$AMAN_HOME/instances/main/.env")" "OIDC_ALLOWED_EMAILS=owner@example.invalid"
  assert_not_contains "$OUT$ERR" "$SENTINEL_PASSWORD"
  assert_tree_lacks "$AMAN_HOME" "$SENTINEL_PASSWORD"
  sandbox_drop
}

test_password_in_the_environment_is_ignored() {
  t_begin "a password in the caller's environment is neither used nor passed on"
  sandbox_new
  AMAN_PASSWORD="env-secret-5d1c"
  install_machine
  unset AMAN_PASSWORD
  assert_rc 0
  assert_eq "$(cat "$SB_STATE/hash_stdin")" "$SENTINEL_PASSWORD"
  assert_not_contains "$(cat "$SB_STATE/hash_env")" "env-secret-5d1c"
  assert_not_contains "$(cat "$STUB_LOG")" "env-secret-5d1c"
  sandbox_drop
}

test_end_of_input_at_the_password_prompt_aborts() {
  t_begin "Ctrl-D at the password prompt stops the run cleanly"
  sandbox_new
  run_install_tty "Instance name=>
Your email=>owner@example.invalid
Go ahead?=>y
Password for the owner account=><EOF>"
  assert_eq "$RC" 1
  assert_contains "$OUT" "No password was entered"
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  assert_no_path "$AMAN_HOME/state/lock"
  assert_eq "$(log_count "docker build")" 0 "nothing was built"
  sandbox_drop
}

test_prompts_and_summary_use_plain_words() {
  t_begin "prompts and the summary avoid jargon and do not present the sign-in service as a page to open"
  sandbox_new
  run_install_tty "Instance name=>
Your email=>owner@example.invalid
Go ahead?=>y
Password for the owner account=>$SENTINEL_PASSWORD
Repeat the password=>$SENTINEL_PASSWORD"
  assert_eq "$RC" 0
  assert_contains "$OUT" "Instance name (a-z, 0-9, hyphen; starts with a letter)"
  assert_contains "$OUT" "Your email, used to sign in"
  assert_contains "$OUT" "Password for the owner account (8 to 72 characters)"
  assert_not_contains "$OUT" "Address you will use" "no question about the address is asked"
  assert_not_contains "$(printf '%s' "$OUT" | tr '[:upper:]' '[:lower:]')" "loopback"
  assert_flat_contains "$OUT" "Sign-in service (used by the app automatically, not a page to open)"
  assert_not_contains "$OUT" "  Login:"
  assert_flat_contains "$OUT" "port 8791 on this computer"
  sandbox_drop
}

test_model_hint() {
  t_begin "a fresh install ends with one line saying to add a model in Settings, and names no model product"
  sandbox_new
  install_machine
  assert_flat_contains "$OUT" "Then add a model in Settings > Models."
  assert_not_contains "$OUT" "must listen on more than 127.0.0.1" "models are set up in the app, not here"
  local product
  for product in ollama llama lmstudio vllm openai; do
    case "$(printf '%s' "$OUT" | tr '[:upper:]' '[:lower:]')" in *"$product"*) t_fail "names a product: $product" ;; *) t_pass ;; esac
  done
  run_install --yes --password-stdin --email owner@example.invalid --model-endpoint http://localhost:11434/v1
  assert_rc 2
  assert_flat_contains "$ERR" "unknown option --model-endpoint"
  sandbox_drop
}

test_list_columns_align() {
  t_begin "instance list pads every column to its widest cell"
  sandbox_new
  install_machine
  with_input "$SENTINEL_PASSWORD
"
  run_install instance add a-rather-long-name --yes --password-stdin --email a.very.long.address.indeed@example.invalid
  clear_input
  run_install instance list
  assert_rc 0
  local header_col row_col line
  header_col=$(printf '%s\n' "$OUT" | head -n 1 | awk '{print index($0, "ADDRESS")}')
  while IFS= read -r line; do
    row_col=$(printf '%s' "$line" | awk '{print index($0, "http://")}')
    assert_eq "$row_col" "$header_col" "address column starts at the same offset"
  done < <(printf '%s\n' "$OUT" | tail -n +2)
  assert_contains "$OUT" "SIGN-IN PORT"
  sandbox_drop
}

test_upgrade_says_what_it_does() {
  t_begin "a real upgrade states its steps; only --check says would"
  sandbox_new
  install_machine
  repo_commit_change "wording"
  run_install upgrade --check
  assert_contains "$OUT" "An upgrade would change:"
  run_install upgrade
  assert_rc 0
  assert_contains "$OUT" "Upgrading these parts of the installed version:"
  assert_not_contains "$OUT" "would change"
  assert_contains "$OUT" "back up every instance, build the new images, restart the instances"
  sandbox_drop
}

test_docker_data_disk_is_checked
test_docker_memory_is_checked
test_out_of_memory_build_points_at_docker_memory
test_password_length_is_checked_up_front
test_password_stdin_is_read_before_any_prompt
test_password_in_the_environment_is_ignored
test_end_of_input_at_the_password_prompt_aborts
test_prompts_and_summary_use_plain_words
test_model_hint
test_list_columns_align
test_upgrade_says_what_it_does
tests_finish
