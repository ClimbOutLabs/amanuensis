"""Runs a command on a pseudo terminal and answers its prompts in order.

Usage: pty_run.py ANSWERS_FILE -- command...  Each ANSWERS_FILE line is "prompt text=>reply". The transcript is
what a terminal would show, so a reply is echoed unless the program turned echo off, as for passwords.
The last line is "[exit N]".
"""
import os, pty, select, sys, time

answers_file = sys.argv[1]
cmd = sys.argv[sys.argv.index("--") + 1:]
answers = []
with open(answers_file) as f:
    for line in f.read().split("\n"):
        if line == "":
            continue
        prompt, _, reply = line.partition("=>")
        answers.append((prompt, reply))

pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
buf = b""
out = b""
idx = 0
deadline = time.time() + 120
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 1.0)
    if fd in r:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
        buf += chunk
        if idx < len(answers) and answers[idx][0].encode() in buf:
            time.sleep(0.05)
            os.write(fd, (answers[idx][1] + "\n").encode())
            buf = b""
            idx += 1
    else:
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            break
        if done:
            break
try:
    _, status = os.waitpid(pid, 0)
except ChildProcessError:
    status = 0
sys.stdout.write(out.decode(errors="replace").replace("\r\n", "\n").replace("\r", ""))
sys.stdout.write("[exit %d]\n" % (os.waitstatus_to_exitcode(status)))
