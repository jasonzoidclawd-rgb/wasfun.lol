"""Restore default SIGINT handling, then exec the real command.

A background child of a non-interactive shell inherits SIGINT = SIG_IGN, and
CPython PRESERVES an inherited SIG_IGN rather than installing its own handler.
`record_session.py` relies on the default handler raising KeyboardInterrupt to
finalise its manifest, so a detached recorder silently ignores `kill -INT` and
runs to its full --max-duration with no artifacts. Signal dispositions survive
exec, so resetting to SIG_DFL here fixes every descendant.
"""

import os
import signal
import sys

signal.signal(signal.SIGINT, signal.SIG_DFL)
os.execv(sys.executable, [sys.executable] + sys.argv[1:])
