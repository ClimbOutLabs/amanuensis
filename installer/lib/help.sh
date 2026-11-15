# shellcheck shell=bash
# The words behind `aman help`: a short overview that groups the commands, and a page for each command with its
# options. Needs ui.sh. Bash 3.2 compatible. Every command the aman shim dispatches has a page here.

HELP_COMMANDS="status upgrade backup restore password doctor import migrate local-model"

_help_row() { # name text: a command and what it does, on one line
  _ui_block "  $(_ui_s 1 "$(printf '%-14s' "$1")")" 16 "$2"
}

HELP_OPTIONS_SHOWN=0

_help_option() { # option text: an option and what it does; options are at most 23 characters
  if [ "$HELP_OPTIONS_SHOWN" = 0 ]; then
    HELP_OPTIONS_SHOWN=1
    ui_heading "Options"
  fi
  _ui_block "  $(_ui_s 1 "$(printf '%-24s' "$1")")" 26 "$2"
}

help_overview() {
  ui_title "Commands for looking after Aman on this computer" "aman"
  ui_heading "Every day"
  _help_row status "Show where to open Aman and how to add a phone or computer"
  _help_row upgrade "Update Aman to the newest version"
  _help_row backup "Save a copy of your chats and settings"
  _help_row restore "Bring back a saved copy"
  _help_row password "Set a new owner password"
  ui_heading "When something is wrong"
  _help_row doctor "Check Aman and fix what is wrong"
  ui_heading "Your data"
  _help_row import "Bring in chats exported from another Aman"
  _help_row migrate "Move over an Aman installed the older way"
  ui_heading "Advanced"
  _help_row local-model "Let Aman use a model running on this computer"
  ui_gap
  ui_line "To see every option of a command, add its name:"
  ui_command "aman help doctor"
}

# help_command NAME: the page of one command; returns 1 for a name that is not a command.
help_command() {
  case "$1" in
    status)
      _help_page status "Shows each instance's addresses and settings, and how to set up a new phone or computer." \
        "aman status"
      ;;
    upgrade)
      _help_page upgrade "Updates Aman to the newest version. It checks that your instances are healthy first." \
        "aman upgrade [--check] [--force]"
      _help_option "--check" "Only show what would change"
      _help_option "--force" "Upgrade even if an instance has a problem"
      ;;
    backup)
      _help_page backup "Saves a copy of your chats and settings. With no name, it saves every instance." \
        "aman backup [NAME]"
      ;;
    restore)
      _help_page restore "Brings back a saved copy of an instance." \
        "aman restore [NAME] [TIME | --latest]"
      _help_option "TIME" "Which saved copy to bring back"
      _help_option "--latest" "Bring back the newest saved copy"
      ;;
    password)
      _help_page password "Sets a new owner password. Run it on the computer where Aman is installed." \
        "aman password [--instance NAME] [--password-stdin]"
      _help_option "--instance NAME" "Which instance, if you have more than one"
      _help_option "--password-stdin" "Read the password from the input"
      ;;
    doctor)
      _help_page doctor "Checks this computer and each instance, and says what to do about any problem." \
        "aman doctor [--json] [--verbose] [--deep] [--local]" \
        "            [--only ID] [--instance NAME]" \
        "aman doctor TOPIC [--fix [--yes]] [--instance NAME]"
      _help_option "--fix" "Repair what the check finds; asks first"
      _help_option "--yes" "With --fix, do not ask"
      _help_option "--verbose" "Show every check, not only problems"
      _help_option "--deep" "Look harder; takes longer"
      _help_option "--local" "Check only this computer"
      _help_option "--only ID" "Run one check"
      _help_option "--instance NAME" "Check one instance"
      _help_option "--json" "Print the result for a program to read"
      ui_heading "Topics"
      ui_line "instance, network, sandbox, docker, disk, backup, checkout and tls. Each checks one thing and, with --fix, repairs it."
      ui_heading "Sandbox options"
      ui_command "aman doctor sandbox [--disk-gb N] [--no-hard-disk-limit]"
      ui_command "                    [--add go,rust,java] [--remove go,rust,java]"
      ui_command "                    [--add-python PACKAGES] [--remove-python PACKAGES]"
      _help_option "--add, --remove" "Put a toolchain in the sandbox or take it out"
      _help_option "--add-python" "Put your own Python packages in the sandbox"
      _help_option "--disk-gb N" "How much disk the sandbox may use"
      _help_option "--no-hard-disk-limit" "Do not enforce that limit"
      ;;
    import)
      _help_page import "Brings in chats exported from another Aman." \
        "aman import FILE [--instance NAME] [--display-name NAME] [--dry-run]"
      _help_option "--dry-run" "Check the file and import nothing"
      _help_option "--display-name NAME" "The name your chats show"
      _help_option "--instance NAME" "Which instance gets the chats"
      ui_hint "An instance that has never started is started once first."
      ;;
    migrate)
      _help_page migrate "Moves over an Aman that was installed the older way, with Docker Compose." \
        "aman migrate --from-compose FOLDER [--user ID]"
      _help_option "--from-compose FOLDER" "The folder the old Aman runs from"
      _help_option "--user ID" "Whose chats to move, if there are several"
      ;;
    local-model)
      _help_page local-model "Lets Aman use a model running on this computer, at the port you give." \
        "aman local-model PORT [--instance NAME] [--remove]"
      _help_option "--remove" "Take the port away"
      _help_option "--instance NAME" "Which instance, if you have more than one"
      ;;
    *) return 1 ;;
  esac
}

_help_page() { # name summary usage...
  local name=$1 summary=$2
  shift 2
  HELP_OPTIONS_SHOWN=0
  ui_title "$summary" "aman $name"
  ui_heading "Usage"
  while [ $# -gt 0 ]; do
    ui_command "$1"
    shift
  done
}
