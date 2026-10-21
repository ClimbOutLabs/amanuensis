#!/usr/bin/env bash
# The automatic daily backup: asked once, scheduled without root where the computer allows it, kept at seven, shown in
# the closing table, and turned on or off by one command.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

mode_file() { cat "$AMAN_HOME/state/backups" 2>/dev/null || true; }
cron_table() { cat "$SB_STATE/crontab" 2>/dev/null || true; }

test_default_install_schedules_a_daily_backup() {
  t_begin "an unattended install backs up every day: a crontab line without root, the choice recorded, one row in the table"
  sandbox_new
  install_machine
  assert_eq "$(mode_file)" daily
  assert_contains "$(cron_table)" "30 3 * * * $AMAN_HOME/bin/aman backup >/dev/null 2>&1 # amanuensis-backup"
  assert_eq "$(cron_table | grep -c 'amanuensis-backup')" 1
  assert_log_lacks "sudo "
  assert_flat_contains "$OUT" "Backups daily, keeps the last 7"
  assert_flat_contains "$OUT$ERR" "Back up automatically every day? [Y/n] yes (--yes)"
  sandbox_drop
}

test_the_plan_names_the_daily_backup() {
  t_begin "the plan lists the daily backup and what runs it, and once it is on the next plan has it done"
  sandbox_new
  run_install --dry-run --email owner@example.invalid
  assert_flat_contains "$OUT" "Back up every day, keeping the last 7"
  assert_flat_contains "$OUT" "Runs at 03:30 with a scheduled task of your user (cron)."
  assert_no_path "$AMAN_HOME"
  install_machine
  run_install --dry-run
  assert_flat_contains "$OUT" "done Daily backups are on"
  sandbox_drop
}

test_backups_off_flag() {
  t_begin "--backups off installs without a schedule and the table says how to turn it on"
  sandbox_new
  INSTALL_EXTRA=(--backups off)
  install_machine
  assert_eq "$(mode_file)" off
  assert_not_contains "$(cron_table)" "amanuensis-backup"
  assert_flat_contains "$OUT" "Backups off. Turn on: aman doctor backup --fix"
  assert_not_contains "$OUT$ERR" "Back up automatically every day?" "the flag answers the question"
  sandbox_drop
}

test_backups_flag_is_checked() {
  t_begin "--backups takes daily or off only"
  sandbox_new
  run_install --dry-run --backups weekly --email owner@example.invalid
  assert_rc 2
  assert_flat_contains "$ERR" "--backups takes daily or off"
  sandbox_drop
}

test_the_question_is_asked_once() {
  t_begin "the interactive install asks 'Back up automatically every day? [Y/n]', n turns it off, and a re-run does not ask again"
  sandbox_new
  run_install_tty "Name for this instance=>
Your email=>owner@example.invalid
What should Aman call you?=>
Connect a calendar?=>n
Back up automatically=>n
Go ahead?=>y
Enter a password for owner@example.invalid=>$SENTINEL_PASSWORD
Enter password again=>$SENTINEL_PASSWORD"
  assert_eq "$RC" 0
  assert_contains "$OUT" "Back up automatically every day? [Y/n]"
  assert_eq "$(mode_file)" off
  assert_not_contains "$(cron_table)" "amanuensis-backup"
  run_install_tty "Connect a calendar?=>n
Go ahead?=>y"
  assert_not_contains "$OUT" "Back up automatically every day?"
  assert_eq "$(mode_file)" off
  sandbox_drop
  sandbox_new
  run_install_tty "Name for this instance=>
Your email=>owner@example.invalid
What should Aman call you?=>
Connect a calendar?=>n
Back up automatically=>
Go ahead?=>y
Enter a password for owner@example.invalid=>$SENTINEL_PASSWORD
Enter password again=>$SENTINEL_PASSWORD"
  assert_eq "$(mode_file)" daily "Enter keeps the default, which is yes"
  sandbox_drop
}

test_an_existing_install_is_asked_once_and_never_after() {
  t_begin "an install from before the daily backup is offered it on the next run, and what is answered stays"
  sandbox_new
  INSTALL_EXTRA=(--backups off)
  install_machine
  rm -f "$AMAN_HOME/state/backups"
  run_install --yes
  assert_rc 0
  assert_eq "$(mode_file)" daily "--yes takes the default"
  run_install --yes --backups off
  assert_eq "$(mode_file)" off
  assert_not_contains "$(cron_table)" "amanuensis-backup"
  sandbox_drop
}

test_the_command_turns_it_on_and_off_and_is_repeatable() {
  t_begin "install.sh backups daily|off changes the schedule, twice in a row is the same as once, and the doctor fix uses it"
  sandbox_new
  INSTALL_EXTRA=(--backups off)
  install_machine
  run_install backups daily
  assert_rc 0
  assert_flat_contains "$OUT" "A backup is made every day, keeping the last 7"
  run_install backups daily
  assert_eq "$(cron_table | grep -c 'amanuensis-backup')" 1 "no second line"
  assert_eq "$(mode_file)" daily
  run_install backups off
  assert_not_contains "$(cron_table)" "amanuensis-backup"
  assert_flat_contains "$OUT" "Automatic backups are off"
  run_install backups sometimes
  assert_rc 2
  sandbox_drop
}

test_other_crontab_lines_are_kept() {
  t_begin "turning the schedule on and off leaves the person's own crontab lines alone"
  sandbox_new
  printf '0 5 * * * /usr/bin/true # mine\n' >"$SB_STATE/crontab"
  install_machine
  assert_contains "$(cron_table)" "0 5 * * * /usr/bin/true # mine"
  run_install backups off
  assert_eq "$(cron_table)" "0 5 * * * /usr/bin/true # mine"
  sandbox_drop
}

test_a_user_systemd_timer_is_used_where_it_works() {
  t_begin "with a systemd user manager the schedule is a user timer, not root and not cron"
  sandbox_new
  fixture_systemctl
  install_machine
  assert_file "$SB/user/.config/systemd/user/aman-backup.timer"
  assert_contains "$(cat "$SB/user/.config/systemd/user/aman-backup.timer")" "OnCalendar=*-*-* 03:30:00"
  assert_contains "$(cat "$SB/user/.config/systemd/user/aman-backup.timer")" "Persistent=true"
  assert_contains "$(cat "$SB/user/.config/systemd/user/aman-backup.service")" "ExecStart=$AMAN_HOME/bin/aman backup"
  assert_log_has "stub-systemctl --user enable --now aman-backup.timer"
  assert_not_contains "$(cron_table)" "amanuensis-backup"
  assert_log_lacks "sudo "
  run_install backups off
  assert_no_path "$SB/user/.config/systemd/user/aman-backup.timer"
  assert_log_has "stub-systemctl --user disable --now aman-backup.timer"
  sandbox_drop
}

test_launchd_is_used_on_macos() {
  t_begin "on macOS the schedule is a launchd agent of the user"
  sandbox_new
  fixture_uname Darwin arm64
  cp "$TESTS_DIR/stubs/launchctl" "$SB_BIN/launchctl"
  install_machine
  assert_file "$SB/user/Library/LaunchAgents/com.amanuensis.backup.plist"
  local plist
  plist=$(cat "$SB/user/Library/LaunchAgents/com.amanuensis.backup.plist")
  assert_contains "$plist" "<string>$AMAN_HOME/bin/aman</string><string>backup</string>"
  assert_contains "$plist" "<key>Hour</key><integer>3</integer>"
  assert_log_has "launchctl bootstrap gui/"
  assert_not_contains "$(cron_table)" "amanuensis-backup"
  sandbox_drop
}

test_no_scheduler_is_said_plainly() {
  t_begin "a computer with no user timer, launchd or crontab is told so once, and nothing is asked or scheduled"
  sandbox_new
  rm -f "$SB_BIN/crontab"
  install_machine
  assert_rc 0
  assert_flat_contains "$OUT$ERR" "Automatic backups are not possible here"
  assert_not_contains "$OUT$ERR" "Back up automatically every day?"
  assert_eq "$(mode_file)" off
  sandbox_drop
}

test_the_schedule_command_works_from_cron() {
  t_begin "the scheduled command is the aman command by its full path, so cron needs no PATH"
  sandbox_new
  install_machine
  local line cmd
  line=$(cron_table | grep amanuensis-backup)
  cmd=${line#30 3 \* \* \* }
  cmd=${cmd%% >*}
  assert_eq "$cmd" "$AMAN_HOME/bin/aman backup"
  assert_eq "$([ -x "$AMAN_HOME/bin/aman" ] && echo yes)" yes
  sandbox_drop
}

test_backups_keep_the_last_seven() {
  t_begin "the daily backups keep the last 7 in ~/.amanuensis/backups"
  sandbox_new
  install_machine
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    run_install backup
  done
  assert_eq "$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" 7
  sandbox_drop
}

test_default_install_schedules_a_daily_backup
test_the_plan_names_the_daily_backup
test_backups_off_flag
test_backups_flag_is_checked
test_the_question_is_asked_once
test_an_existing_install_is_asked_once_and_never_after
test_the_command_turns_it_on_and_off_and_is_repeatable
test_other_crontab_lines_are_kept
test_a_user_systemd_timer_is_used_where_it_works
test_launchd_is_used_on_macos
test_no_scheduler_is_said_plainly
test_the_schedule_command_works_from_cron
test_backups_keep_the_last_seven
tests_finish
