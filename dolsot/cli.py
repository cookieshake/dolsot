"""The `dolsot` command. A thin shell over Repl: parse, run, print, exit.

    dolsot --toolbox mytools:mt --session work "mt.add(1, 2)"
    echo "2 ** 10" | dolsot --toolbox mytools:mt --session work
    dolsot --list-sessions
    dolsot --reset work
"""
from __future__ import annotations

import argparse
import sys
import time

from .core import InvalidSession, InvalidToolbox, Repl, persistence_notes
from .store import FileStore

SESSION_HELP = (
    "error: --session <id> is required. Reuse one stable id per task so state "
    "(variables, DataFrames, imports) persists across calls; use a different id for "
    "an isolated workspace."
)


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="dolsot", description="Stateful Python REPL for agents.")
    p.add_argument("--toolbox", action="append", default=[], metavar="MODULE:ALIAS",
                   help="Inject MODULE into the namespace as ALIAS. Repeatable.")
    p.add_argument("-s", "--session", help="Session id. State persists under this id.")
    p.add_argument("-t", "--timeout", type=int, help="Wall-clock seconds (default 20).")
    p.add_argument("--list-sessions", action="store_true", help="List sessions and exit.")
    p.add_argument("--reset", metavar="ID", help="Forget a session (or 'all') and exit.")
    p.add_argument("code", nargs="*", help="Python to run. Read from stdin when omitted.")
    return p


def _inject_from(specs: list[str]) -> dict[str, str]:
    inject: dict[str, str] = {}
    for spec in specs:
        module, sep, alias = spec.partition(":")
        if not sep or not module or not alias:
            raise InvalidToolbox(f"bad --toolbox {spec!r}: expected MODULE:ALIAS")
        inject[alias] = module
    return inject


def main() -> int:
    # Toolbox output is arbitrary text; an ASCII stdout (C locale, a redirected
    # pipe) would otherwise turn a non-ASCII value into a raw UnicodeEncodeError
    # traceback. Degrade to escapes instead of crashing the host.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="backslashreplace")
        except (AttributeError, ValueError):
            pass

    args = _parser().parse_args()

    try:
        inject = _inject_from(args.toolbox)
    except InvalidToolbox as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.list_sessions:
        infos = FileStore().list()
        if not infos:
            print("(no sessions)")
            return 0
        now = time.time()
        for i in infos:
            age_h = (now - i.last_used) / 3600
            print(f"{i.id:24}  {i.size_bytes / 1024:8.1f} KB   last used {age_h:6.1f}h ago")
        return 0

    repl = Repl(inject=inject, timeout=args.timeout)

    if args.reset is not None:
        try:
            n = repl.reset(args.reset)
        except InvalidSession as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        print(f"reset {n} session(s)")
        return 0

    if not args.session:
        print(SESSION_HELP, file=sys.stderr)
        return 2

    code = "\n".join(args.code) if args.code else sys.stdin.read()

    try:
        result = repl.run(args.session, code)
    except InvalidSession as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if result.stdout:
        sys.stdout.write(result.stdout)
        if not result.stdout.endswith("\n"):
            sys.stdout.write("\n")
    if result.value is not None:
        print(result.value)
    if result.error:
        print(f"error: {result.error}", file=sys.stderr)
    for line in persistence_notes(
        args.session, result.held, result.dropped, result.save_error
    ):
        print(line, file=sys.stderr)
    return result.exit_code


if __name__ == "__main__":
    sys.exit(main())
