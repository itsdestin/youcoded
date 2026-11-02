"""Phase 0 trial: what does a brand-new Claude Code show when started in a terminal with only an API key?

WHY: the app runs Claude Code in a terminal. On a new install it stops at first-run screens (text style, security
notes, trust this folder) that the walk-through must get past with nobody watching (Android report #2). This records
each screen it meets, pressing Enter (the default choice) to move on, so the walk-through knows what to expect.
Prints the screens as plain text; never prints the key.
"""
import os, pty, re, select, sys, time

ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b[78]|\x0f|\r')
# WHY: Claude Code's "use this API key?" screen shows the key's last 20 characters, and this repo's CI logs are
# public. GitHub only hides the WHOLE secret, so blank anything key-shaped before printing (found 2026-11-01).
KEYISH = re.compile(r'sk-ant-[^\s]*')

def read_for(fd, seconds):
    out, end = b'', time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: chunk = os.read(fd, 65536)
            except OSError: break
            if not chunk: break
            out += chunk
    return KEYISH.sub('sk-ant-[hidden]', ANSI.sub('', out.decode('utf-8', 'replace')))

work = sys.argv[1]
os.makedirs(work, exist_ok=True)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(work)
    os.execvp('claude', ['claude'])
for step in range(8):
    screen = read_for(fd, 8)
    lines = [l.rstrip() for l in screen.splitlines() if l.strip()]
    print(f'===== screen {step} =====')
    print('\n'.join(lines[-25:]) or '(nothing new)')
    if any(s in screen for s in ('? for shortcuts', 'Try "', '>\xa0')) and step > 0:
        print('===== reached the message box =====')
        os.write(fd, b'Reply with exactly the word: pineapple\r')
        reply = read_for(fd, 40)
        print('pineapple seen in reply:', 'pineapple' in reply.lower())
        print('\n'.join([l.rstrip() for l in reply.splitlines() if l.strip()][-15:]))
        break
    if 'usethisAPIkey' in screen.replace(' ', ''):   # the terminal drops spaces unpredictably, so compare without them
        # Test-only question (a real user signs in instead): its default is No, so pick Yes explicitly.
        os.write(fd, b'\x1b[A'); time.sleep(0.3)
    if 'Paste code here' in screen or 'Pastecodehere' in screen:
        print('===== stuck at browser sign-in: the key was not accepted =====')
        break
    os.write(fd, b'\r')   # take the default choice and move on
os.kill(pid, 9)
