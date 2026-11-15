"""Runs a command on a pseudo terminal and answers its prompts in order.

Usage: pty_run.py ANSWERS_FILE -- command...  Each ANSWERS_FILE line is "prompt text=>reply" ("<EOF>" sends Ctrl-D). The transcript is
what a terminal would show, so a reply is echoed unless the program turned echo off, as for passwords.
A line that starts with "*" is a standing answer: it is given every time its prompt shows, wherever that falls among
the others. The reply "<RECOVERY_KEY>" types back the last recovery key on the screen, as a person reading it would.
The last line is "[exit N]".
"""
import os, pty, re, select, sys, time

answers_file = sys.argv[1]
cmd = sys.argv[sys.argv.index("--") + 1:]
answers = []
standing = []
with open(answers_file) as f:
    for line in f.read().split("\n"):
        if line == "":
            continue
        prompt, _, reply = line.partition("=>")
        if prompt.startswith("*"):
            standing.append((prompt[1:], reply))
        else:
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
        asked = next((pair for pair in standing if pair[0].encode() in buf), None)
        if asked is None and idx < len(answers) and answers[idx][0].encode() in buf:
            asked = answers[idx]
            idx += 1
        if asked is not None:
            time.sleep(0.05)
            reply = asked[1]
            if reply == "<RECOVERY_KEY>":
                keys = re.findall(rb"\d{6}(?:-\d{6}){7}", out)
                reply = keys[-1].decode() if keys else ""
            # "<EOF>" sends Ctrl-D at the start of a line, as a person ending the input would.
            os.write(fd, b"\x04" if reply == "<EOF>" else (reply + "\n").encode())
            buf = b""
    else:
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            break
        if done:
            break
if time.time() >= deadline:
    os.kill(pid, 9)
    sys.stderr.write("pty_run: gave up waiting; unanswered prompt or hang\n")
try:
    _, status = os.waitpid(pid, 0)
except ChildProcessError:
    status = 0
sys.stdout.write(out.decode(errors="replace").replace("\r\n", "\n").replace("\r", ""))
sys.stdout.write("[exit %d]\n" % (os.waitstatus_to_exitcode(status)))
