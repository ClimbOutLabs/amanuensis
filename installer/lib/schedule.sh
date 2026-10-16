# shellcheck shell=bash
# The automatic daily backup: a user systemd timer on Linux, a launchd agent on macOS, a crontab line where neither
# exists. None needs root. The choice (daily or off) is kept in the state directory; absent means never asked.

BACKUP_UNIT=aman-backup
BACKUP_LAUNCHD_LABEL=com.amanuensis.backup
BACKUP_CRON_TAG='# amanuensis-backup'
BACKUP_HOUR=3
BACKUP_MINUTE=30

backups_mode_file() { printf '%s/backups' "$STATE_DIR"; }

# daily, off, or nothing when it was never chosen.
backups_mode() { cat "$(backups_mode_file)" 2>/dev/null || true; }

backup_command() { printf '%s/bin/aman backup' "$AMAN_HOME"; }

backup_systemd_dir() { printf '%s/.config/systemd/user' "$HOME"; }
backup_launchd_file() { printf '%s/Library/LaunchAgents/%s.plist' "$HOME" "$BACKUP_LAUNCHD_LABEL"; }

# Which scheduler this computer can use without root: systemd (a user manager that answers), launchd, or cron.
backup_scheduler() {
  if [ "$(uname -s)" = Darwin ]; then
    if command -v launchctl >/dev/null 2>&1; then echo launchd; return; fi
  elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    echo systemd
    return
  fi
  # A crontab line does nothing unless cron is running, which it often is not where there is no systemd (WSL2).
  if command -v crontab >/dev/null 2>&1 && { pgrep -x cron || pgrep -x crond; } >/dev/null 2>&1; then echo cron; fi
}

# What the schedule is made of, in words for the plan.
backup_scheduler_label() {
  case "$(backup_scheduler)" in
    systemd) echo "a timer of your user" ;;
    launchd) echo "a launchd agent of your user" ;;
    cron) echo "a crontab line of your user" ;;
  esac
}

# True when any of the three schedules is in place.
backup_schedule_present() {
  if [ -f "$(backup_systemd_dir)/$BACKUP_UNIT.timer" ] && systemctl --user is-enabled "$BACKUP_UNIT.timer" >/dev/null 2>&1; then return 0; fi
  if [ -f "$(backup_launchd_file)" ]; then return 0; fi
  if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -Fq "$BACKUP_CRON_TAG"; then return 0; fi
  return 1
}

backup_schedule_enable() { # scheduler
  local cmd dir
  cmd=$(backup_command)
  case "$1" in
    systemd)
      dir=$(backup_systemd_dir)
      mkdir -p "$dir"
      printf '[Unit]\nDescription=Aman daily backup\n\n[Service]\nType=oneshot\nExecStart=%s\n' "$cmd" >"$dir/$BACKUP_UNIT.service"
      printf '[Unit]\nDescription=Aman daily backup\n\n[Timer]\nOnCalendar=*-*-* %02d:%02d:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n' \
        "$BACKUP_HOUR" "$BACKUP_MINUTE" >"$dir/$BACKUP_UNIT.timer"
      systemctl --user daemon-reload && systemctl --user enable --now "$BACKUP_UNIT.timer" >/dev/null 2>&1 || return 1
      # So the timer also runs while nobody is logged in; allowed for one's own user on most systems, harmless when not.
      loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
      ;;
    launchd)
      mkdir -p "$(dirname "$(backup_launchd_file)")"
      cat >"$(backup_launchd_file)" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$BACKUP_LAUNCHD_LABEL</string>
<key>ProgramArguments</key><array><string>${cmd% backup}</string><string>backup</string></array>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>$BACKUP_HOUR</integer><key>Minute</key><integer>$BACKUP_MINUTE</integer></dict>
</dict></plist>
PLIST
      launchctl bootout "gui/$(id -u)" "$(backup_launchd_file)" >/dev/null 2>&1 || true
      launchctl bootstrap "gui/$(id -u)" "$(backup_launchd_file)" >/dev/null 2>&1 || return 1
      ;;
    cron)
      { crontab -l 2>/dev/null | grep -vF "$BACKUP_CRON_TAG" || true; printf '%s %s * * * %s >/dev/null 2>&1 %s\n' "$BACKUP_MINUTE" "$BACKUP_HOUR" "$cmd" "$BACKUP_CRON_TAG"; } | crontab - || return 1
      ;;
    *) return 1 ;;
  esac
}

# Removes every schedule this installer may have made, whichever scheduler holds it.
backup_schedule_disable() {
  if [ -f "$(backup_systemd_dir)/$BACKUP_UNIT.timer" ]; then
    systemctl --user disable --now "$BACKUP_UNIT.timer" >/dev/null 2>&1 || true
    rm -f "$(backup_systemd_dir)/$BACKUP_UNIT.timer" "$(backup_systemd_dir)/$BACKUP_UNIT.service"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  if [ -f "$(backup_launchd_file)" ]; then
    launchctl bootout "gui/$(id -u)" "$(backup_launchd_file)" >/dev/null 2>&1 || true
    rm -f "$(backup_launchd_file)"
  fi
  if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -Fq "$BACKUP_CRON_TAG"; then
    { crontab -l 2>/dev/null | grep -vF "$BACKUP_CRON_TAG" || true; } | crontab - || true
  fi
}

# Applies the choice: daily puts a schedule in place (replacing any other), off removes them all. Records the choice
# only when it worked, so the doctor's fix can try again.
backups_apply() { # daily|off
  local scheduler
  case "$1" in
    off)
      backup_schedule_disable
      ensure_private_dir "$STATE_DIR"
      printf 'off\n' | write_if_changed "$(backups_mode_file)" 600 || true
      ;;
    daily)
      scheduler=$(backup_scheduler)
      [ -n "$scheduler" ] || return 1
      backup_schedule_disable
      backup_schedule_enable "$scheduler" || return 1
      ensure_private_dir "$STATE_DIR"
      printf 'daily\n' | write_if_changed "$(backups_mode_file)" 600 || true
      log_event "daily backups on ($scheduler)"
      ;;
    *) return 1 ;;
  esac
}
