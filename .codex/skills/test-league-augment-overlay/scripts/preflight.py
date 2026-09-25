#!/usr/bin/env python3
"""Read-only provenance checks for a Mayhem Oracle overlay validation run."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable

# Mandatory tools are derived from the commands this validation workflow
# actually invokes:
#   ffmpeg   — capture-device enumeration, screen recording, frame extraction
#   ffprobe  — recorded-video stream/duration validation
#   git      — repository provenance (branch, HEAD, dirty count) in the report
#   lsof     — overlay cwd resolution and trace file-holder pinning
#   python3  — the documented `python3 <script>` entry points
REQUIRED_TOOLS = ("ffmpeg", "ffprobe", "git", "lsof", "python3")

# Operator conveniences. No script in this skill shells out to them, so a
# missing one is reported but never blocks a run.
OPTIONAL_TOOLS = ("jq", "rg", "screencapture")

# Process inventory. Invoked by absolute path so a shadowed `ps` on PATH cannot
# change what the overlay/client/game process check sees.
PROCESS_LISTING = "/bin/ps"

# Never read, logged, or returned by value — only checked for presence by
# name. A same-worktree overlay launched from a credentialed shell can upload
# telemetry data externally even though it passes every process-group check,
# so this must inspect the exact pinned overlay process itself.
FORBIDDEN_CREDENTIAL_ENV_NAMES = ("MAYHEM_TELEMETRY_ENDPOINT", "MAYHEM_DEVICE_TOKEN")

# Bumped only if the digest's input construction changes; a manifest's
# recorded schema is what lets a later reader know which construction a
# stored digest was produced under.
REPOSITORY_FINGERPRINT_SCHEMA = 1

# A file changing between its pre-read and post-read stat is treated as
# unread rather than retried forever — a small, bounded number of attempts,
# then fail closed.
UNTRACKED_READ_MAX_ATTEMPTS = 3


def run(args: list[str], cwd: Path | None = None) -> tuple[int, str]:
    completed = subprocess.run(
        args,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    return completed.returncode, completed.stdout.strip()


def process_listing_available() -> bool:
    return os.access(PROCESS_LISTING, os.X_OK)


def process_rows() -> list[dict[str, object]]:
    code, output = run([PROCESS_LISTING, "-axo", "pid=,ppid=,pgid=,comm="])
    if code:
        return []
    rows: list[dict[str, object]] = []
    for line in output.splitlines():
        parts = line.strip().split(maxsplit=3)
        if len(parts) != 4:
            continue
        rows.append(
            {
                "pid": int(parts[0]),
                "ppid": int(parts[1]),
                "pgid": int(parts[2]),
                "comm": parts[3],
            }
        )
    return rows


def process_cwd(pid: int) -> str | None:
    lsof = shutil.which("lsof")
    if not lsof:
        return None
    code, output = run([lsof, "-a", "-p", str(pid), "-d", "cwd", "-Fn"])
    if code:
        return None
    for line in output.splitlines():
        if line.startswith("n"):
            return line[1:]
    return None


# Bounded wait for one holder-inspection invocation. A hung `lsof` (stale
# network mount, wedged kernel query) must become indeterminate rather than
# block a caller indefinitely.
LSOF_HOLDER_TIMEOUT_SECONDS = 5.0


def file_holder_access(path: Path) -> list[dict[str, object]] | None:
    """Every open file descriptor on `path`, as `{"pid", "access"}` pairs.

    `access` is lsof's per-descriptor access mode: `"r"` (read-only), `"w"`
    (write-only), or `"u"` (read/write) — the dimension a PID-only or
    PGID-only holder check cannot see. A foreign process reading the trace
    cannot inject fabricated records; a foreign process writing it can.

    Three distinct outcomes, never conflated:
      - a list with entries: successfully inspected, holders found.
      - an empty list: successfully inspected, confirmed nobody holds it —
        credited ONLY for the one documented "no match" `lsof` outcome, a
        nonzero exit with nothing at all on stdout or stderr.
      - `None`: indeterminate — missing `lsof`, a process-launch failure, a
        timeout, any other nonzero exit (permission denial, a malformed
        invocation, a transient failure — all of which carry output on one
        of the streams), or output this parser cannot fully vouch for.
    Callers must treat `None` the same as a confirmed foreign writer, never
    as "no writers": an inspection we cannot trust must never be read as an
    empty trusted-holder set.
    """
    lsof = shutil.which("lsof")
    if not lsof:
        return None
    try:
        completed = subprocess.run(
            [lsof, "-Fpfa", "--", str(path)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=LSOF_HOLDER_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        if not completed.stdout and not completed.stderr:
            return []
        # Some other nonzero exit: a permission warning, a usage dump from a
        # malformed invocation, or a transient failure. None of these is the
        # documented no-match outcome, so the inspection is indeterminate —
        # its raw stdout/stderr is discarded here and never returned.
        return None
    return _parse_holder_records(completed.stdout)


def _parse_holder_records(output: str) -> list[dict[str, object]] | None:
    """Strict `-Fpfa` parse. `None` if any record cannot be fully vouched for.

    A `p` value is only trusted holder identity when it is entirely digits;
    an `a` value is only trusted access when a valid `p` already opened the
    record it belongs to. Reject anything else outright — a non-digit pid,
    an access field with no pid in scope, an unrecognized field tag, or an
    access value that is neither a known mode nor lsof's blank/not-applicable
    marker — rather than silently dropping the one piece we cannot read.
    """
    holders: list[dict[str, object]] = []
    pid: int | None = None
    for line in output.splitlines():
        if not line:
            continue
        tag, value = line[0], line[1:]
        if tag == "p":
            if not value.isdigit():
                return None
            pid = int(value)
        elif tag == "f":
            continue
        elif tag == "a":
            if pid is None:
                return None
            if value in ("r", "w", "u"):
                holders.append({"pid": pid, "access": value})
            elif value.strip():
                return None
        else:
            return None
    return holders


def git_value(repo: Path, *args: str) -> str:
    git = shutil.which("git")
    if not git:
        return ""
    code, output = run([git, *args], cwd=repo)
    return output if code == 0 else ""


def _credential_environment_unverified() -> dict[str, object]:
    # Fail closed: an environment we could not actually inspect must never be
    # reported as clean.
    return {
        "credentialEnvironmentVerified": False,
        "forbiddenCredentialNamesPresent": True,
    }


def credential_environment_check(pid: int) -> dict[str, object]:
    """Verify the exact pinned overlay process's environment carries neither
    forbidden credential variable name.

    Only presence of a name is checked — never a value. The macOS
    implementation targets the exact PID via `ps -E`, parses environment-
    variable name boundaries out of its output, and discards the raw output
    immediately; nothing from it is retained, logged, or returned. Verifying
    the trace holder's process group is not a substitute for this: a
    same-worktree overlay launched from a credentialed shell can still pass
    process-group checks, so this inspects the pinned overlay PID itself.

    Returns `None`-safe fail-closed results if: process listing is
    unavailable; `pid` no longer identifies a `mayhem-oracle-overlay` process
    (exited, replaced, or never matched — this also catches PID reuse between
    checkpoints); `ps` exits non-zero; or its output cannot be read. A clean
    result requires a successful inspection that found neither name.
    """
    if not process_listing_available():
        return _credential_environment_unverified()
    rows = process_rows()
    row = next((r for r in rows if int(r["pid"]) == pid), None)
    if row is None or Path(str(row["comm"])).name != "mayhem-oracle-overlay":
        return _credential_environment_unverified()
    completed = subprocess.run(
        [PROCESS_LISTING, "-E", "-ww", "-p", str(pid)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        return _credential_environment_unverified()
    lines = completed.stdout.splitlines()
    body = "\n".join(lines[1:]) if len(lines) > 1 else ""
    if not body.strip():
        return _credential_environment_unverified()
    present = any(
        re.search(rf"(?:^|\s){re.escape(name)}=", body)
        for name in FORBIDDEN_CREDENTIAL_ENV_NAMES
    )
    return {
        "credentialEnvironmentVerified": True,
        "forbiddenCredentialNamesPresent": present,
    }


def dirty_status_entries(repo: Path) -> list[dict[str, object]] | None:
    """Every changed repository path, expanded and normalized.

    `git status --short` collapses an entire untracked directory into one
    line (`?? .codex/`), undercounting the actual dirty paths recorded as
    provenance. `--untracked-files=all` expands every file inside it, and
    `-z` NUL-terminates each record with raw, unquoted bytes instead of the
    C-style octal escaping plain output applies to spaces and non-ASCII
    names — so nothing here depends on shell word-splitting.

    Returns `None` if git status cannot be read at all (missing `git`,
    non-zero exit, or a name that is not valid UTF-8); a repository this
    cannot be read for is never reported as clean.
    """
    git = shutil.which("git")
    if not git:
        return None
    completed = subprocess.run(
        [git, "status", "--porcelain=1", "--untracked-files=all", "-z"],
        cwd=repo,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        return None
    fields = completed.stdout.split(b"\x00")
    entries: list[dict[str, object]] = []
    index = 0
    try:
        while index < len(fields):
            field = fields[index]
            index += 1
            if not field:
                continue
            if len(field) < 3:
                return None
            status = field[:2].decode("utf-8")
            path = field[3:].decode("utf-8")
            renamed_from = None
            if status[0] in ("R", "C"):
                if index >= len(fields):
                    return None
                renamed_from = fields[index].decode("utf-8")
                index += 1
            entries.append(
                {"status": status, "path": path, "renamedFrom": renamed_from}
            )
    except UnicodeDecodeError:
        return None
    entries.sort(key=lambda entry: str(entry["path"]))
    return entries


def _raw_diff(git: str, repo: Path, *extra: str) -> bytes | None:
    completed = subprocess.run(
        [git, "diff", "--binary", "--no-ext-diff", *extra],
        cwd=repo,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        return None
    return completed.stdout


def _read_untracked_entry(full_path: Path) -> tuple[bytes, bytes] | None:
    """Read one untracked file's exact bytes, or its symlink target bytes.

    Fails closed (returns `None`) on an unsupported special file (device,
    socket, FIFO), a read error, or content that could not be proven stable
    across the read after `UNTRACKED_READ_MAX_ATTEMPTS` attempts. A symlink's
    target is never followed — only the link's own target bytes are hashed,
    so a symlink pointing outside the repository never pulls in foreign file
    content.

    Returns `(content_bytes, mode_tag)`, where `mode_tag` is a 3-byte type +
    permission encoding: `b"\\x01"` for a symlink (permission bits are
    meaningless for a symlink, so they are normalized to zero) or `b"\\x00"`
    for a regular file, followed by a 2-byte big-endian POSIX permission mode.
    """
    for _ in range(UNTRACKED_READ_MAX_ATTEMPTS):
        try:
            before = full_path.lstat()
        except OSError:
            return None
        if stat.S_ISLNK(before.st_mode):
            try:
                content = os.fsencode(os.readlink(full_path))
            except OSError:
                continue
            mode_tag = b"\x01" + (0).to_bytes(2, "big")
        elif stat.S_ISREG(before.st_mode):
            try:
                content = full_path.read_bytes()
            except OSError:
                continue
            mode_tag = b"\x00" + stat.S_IMODE(before.st_mode).to_bytes(2, "big")
        else:
            # Unsupported special file (device, socket, FIFO, ...): never
            # silently skipped, and never hashed as if it were ordinary
            # content.
            return None
        try:
            after = full_path.lstat()
        except OSError:
            continue
        if (
            before.st_dev == after.st_dev
            and before.st_ino == after.st_ino
            and before.st_size == after.st_size
            and before.st_mtime_ns == after.st_mtime_ns
            and stat.S_IFMT(before.st_mode) == stat.S_IFMT(after.st_mode)
            and stat.S_IMODE(before.st_mode) == stat.S_IMODE(after.st_mode)
        ):
            return content, mode_tag
        # The file changed under us between the two stat calls; retry rather
        # than trust a read that straddled a mutation.
    return None


def _resolve_exclusion_prefixes(exclude_paths: Iterable[Path] | None) -> tuple[str, ...]:
    if not exclude_paths:
        return ()
    return tuple(str(Path(path).resolve()) for path in exclude_paths)


def _path_is_excluded(repo: Path, path_str: str, excluded_prefixes: tuple[str, ...]) -> bool:
    if not excluded_prefixes:
        return False
    resolved = str((repo / path_str).resolve())
    return any(
        resolved == prefix or resolved.startswith(prefix + os.sep)
        for prefix in excluded_prefixes
    )


def _length_prefixed(digest: Any, data: bytes) -> None:
    # An 8-byte big-endian length prefix ahead of every field is a domain
    # separator: without it, `("ab", "c")` and `("a", "bc")` would hash
    # identically once concatenated.
    digest.update(len(data).to_bytes(8, "big"))
    digest.update(data)


def repository_fingerprint(
    repo: Path, exclude_paths: Iterable[Path] | None = None
) -> dict[str, Any] | None:
    """Deterministic content fingerprint over the exact current worktree state.

    Binds, in order: the schema version, HEAD, the staged tracked diff bytes,
    the unstaged tracked diff bytes, and every untracked file's repo-relative
    path plus exact content (or symlink target bytes, never followed) plus a
    type/permission tag — each field length-prefixed so no ambiguous
    concatenation is possible. Two uncommitted patches that touch the same
    paths with different bytes always produce different digests; tracked
    mode/symlink changes are already represented verbatim inside git's own
    diff bytes.

    `exclude_paths` lets a caller keep its own owner-only evidence output
    directory (if it happens to live inside the repository) from feeding back
    into the fingerprint it is itself supposed to be pinned against.

    Returns `None` — never a partial or best-effort digest — if: git or the
    repository cannot be read; any untracked file fails to read cleanly (see
    `_read_untracked_entry`); or the repository mutates out from under the
    read faster than the bounded retry budget can tolerate. A repository this
    cannot be fully re-read for is never reported as unchanged.
    """
    git = shutil.which("git")
    if not git:
        return None
    head = git_value(repo, "rev-parse", "HEAD")
    if not head:
        return None
    dirty_entries = dirty_status_entries(repo)
    if dirty_entries is None:
        return None
    excluded_prefixes = _resolve_exclusion_prefixes(exclude_paths)
    if excluded_prefixes:
        dirty_entries = [
            entry
            for entry in dirty_entries
            if not _path_is_excluded(repo, str(entry["path"]), excluded_prefixes)
        ]

    staged = _raw_diff(git, repo, "--cached")
    if staged is None:
        return None
    unstaged = _raw_diff(git, repo)
    if unstaged is None:
        return None

    content_entries: list[tuple[bytes, bytes, bytes]] = []
    for entry in dirty_entries:
        if entry["status"] != "??":
            continue
        path_str = str(entry["path"])
        read = _read_untracked_entry(repo / path_str)
        if read is None:
            return None
        content, mode_tag = read
        content_entries.append(
            (path_str.encode("utf-8", "surrogateescape"), mode_tag, content)
        )
    content_entries.sort(key=lambda item: item[0])

    digest = hashlib.sha256()
    _length_prefixed(
        digest,
        f"mayhem-overlay-repo-fingerprint/{REPOSITORY_FINGERPRINT_SCHEMA}".encode(
            "ascii"
        ),
    )
    _length_prefixed(digest, head.encode("utf-8"))
    _length_prefixed(digest, staged)
    _length_prefixed(digest, unstaged)
    digest.update(len(content_entries).to_bytes(8, "big"))
    for path_bytes, mode_tag, content in content_entries:
        _length_prefixed(digest, path_bytes)
        _length_prefixed(digest, mode_tag)
        _length_prefixed(digest, content)

    return {
        "schema": REPOSITORY_FINGERPRINT_SCHEMA,
        "sha256": digest.hexdigest(),
        "headCommit": head,
        "dirtyPathCount": len(dirty_entries),
        "dirtyPaths": [str(entry["path"]) for entry in dirty_entries],
    }


def parse_capture_devices(output: str) -> list[dict[str, object]]:
    devices: list[dict[str, object]] = []
    in_video_section = False
    pattern = re.compile(r"\[(?P<index>\d+)\]\s+(?P<label>.+)$")
    for line in output.splitlines():
        if "AVFoundation video devices:" in line:
            in_video_section = True
            continue
        if "AVFoundation audio devices:" in line:
            in_video_section = False
            continue
        if not in_video_section:
            continue
        match = pattern.search(line)
        if not match:
            continue
        label = match.group("label").strip()
        if re.search(r"\bscreen\b", label, re.IGNORECASE):
            devices.append({"index": int(match.group("index")), "label": label})
    return devices


def capture_devices(ffmpeg: str) -> list[dict[str, object]]:
    _, output = run(
        [ffmpeg, "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]
    )
    return parse_capture_devices(output)


def collect(
    repo: Path,
    require_overlay: bool,
    require_game: bool,
    overlay_pid: int | None = None,
) -> dict[str, object]:
    errors: list[str] = []
    required_tools = {name: shutil.which(name) for name in REQUIRED_TOOLS}
    optional_tools = {name: shutil.which(name) for name in OPTIONAL_TOOLS}
    tools = {**required_tools, **optional_tools}
    missing_required = [name for name, value in required_tools.items() if value is None]
    missing_optional = [name for name, value in optional_tools.items() if value is None]
    process_listing_ok = process_listing_available()
    if platform.system() != "Darwin":
        errors.append("This live skill requires macOS.")
    if not (repo / "overlay" / "package.json").is_file():
        errors.append(f"Not a Mayhem Oracle repository: {repo}")
    if missing_required:
        errors.append("Missing required tools: " + ", ".join(missing_required))
    if not process_listing_ok:
        errors.append(
            f"Process inspection is unavailable: {PROCESS_LISTING} is not executable."
        )

    rows = process_rows()
    all_overlays = [
        row
        for row in rows
        if Path(str(row["comm"])).name == "mayhem-oracle-overlay"
    ]
    overlay = (
        [row for row in all_overlays if row["pid"] == overlay_pid]
        if overlay_pid is not None
        else all_overlays
    )
    for row in overlay:
        row["cwd"] = process_cwd(int(row["pid"]))
    clients = [
        row for row in rows if str(row["comm"]).endswith("/LeagueClientUx")
    ]
    games = [
        row for row in rows if str(row["comm"]).endswith("/LeagueofLegends")
    ]

    if require_overlay and not overlay:
        suffix = f" with pid {overlay_pid}" if overlay_pid is not None else ""
        errors.append(f"No running Mayhem Oracle overlay process was found{suffix}.")
    if require_overlay and overlay_pid is None and len(overlay) != 1:
        errors.append(
            f"Expected exactly one overlay process; found {len(overlay)}. "
            "Pass --overlay-pid to pin one."
        )
    if require_overlay and overlay:
        expected_overlay = str((repo / "overlay").resolve())
        wrong = [
            row
            for row in overlay
            if row.get("cwd") is None
            or (
                row.get("cwd") != expected_overlay
                and not str(row.get("cwd")).startswith(expected_overlay + "/")
            )
        ]
        if wrong:
            errors.append("The pinned overlay cwd is missing or belongs to another worktree.")
    if require_game and not games:
        errors.append("No running League game process was found.")

    credential_environment: dict[str, object] | None = None
    if len(overlay) == 1:
        credential_environment = credential_environment_check(int(overlay[0]["pid"]))
        if not (
            credential_environment["credentialEnvironmentVerified"]
            and not credential_environment["forbiddenCredentialNamesPresent"]
        ):
            errors.append(
                "The pinned overlay process's credential environment could not "
                "be verified clear of MAYHEM_TELEMETRY_ENDPOINT / "
                "MAYHEM_DEVICE_TOKEN."
            )

    branch = git_value(repo, "branch", "--show-current")
    head = git_value(repo, "rev-parse", "HEAD")
    dirty_entries = dirty_status_entries(repo)
    if dirty_entries is None:
        errors.append("Could not read git status for the repository.")
        dirty_entries = []
    ffmpeg = tools.get("ffmpeg")
    displays = capture_devices(str(ffmpeg)) if ffmpeg else []
    if ffmpeg and not displays:
        errors.append("FFmpeg did not report a screen capture device.")

    return {
        "ok": not errors,
        "errors": errors,
        "platform": {
            "system": platform.system(),
            "release": platform.mac_ver()[0],
            "machine": platform.machine(),
        },
        "repository": {
            "path": str(repo),
            "branch": branch,
            "head": head,
            "dirtyCount": len(dirty_entries),
            "dirtyPaths": [str(entry["path"]) for entry in dirty_entries],
            "dirtyEntries": dirty_entries,
        },
        "tools": tools,
        "requiredTools": required_tools,
        "optionalTools": optional_tools,
        "missingRequiredTools": missing_required,
        "missingOptionalTools": missing_optional,
        "processInspection": {
            "path": PROCESS_LISTING,
            "available": process_listing_ok,
        },
        "captureDevices": displays,
        "processes": {
            "overlay": overlay,
            "leagueClientUx": clients,
            "leagueGame": games,
        },
        "credentialEnvironment": credential_environment,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--require-overlay", action="store_true")
    parser.add_argument("--require-game", action="store_true")
    parser.add_argument("--overlay-pid", type=int)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    repo = args.repo.resolve()
    result = collect(
        repo,
        args.require_overlay,
        args.require_game,
        overlay_pid=args.overlay_pid,
    )
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(f"repo: {result['repository']['path']}")
        print(
            f"branch/head: {result['repository']['branch']} "
            f"{result['repository']['head']}"
        )
        print(f"dirty paths: {result['repository']['dirtyCount']}")
        print(
            "missing required tools: "
            + (", ".join(result["missingRequiredTools"]) or "none")
        )
        print(
            "missing optional tools: "
            + (", ".join(result["missingOptionalTools"]) or "none")
            + " (never blocking)"
        )
        print(
            f"process inspection: {result['processInspection']['path']} "
            + ("available" if result["processInspection"]["available"] else "MISSING")
        )
        for kind, rows in result["processes"].items():
            summary = ", ".join(
                f"pid={row['pid']}"
                + (f" cwd={row['cwd']}" if row.get("cwd") else "")
                for row in rows
            )
            print(f"{kind}: {summary or 'none'}")
        display_summary = ", ".join(
            f"{row['index']}:{row['label']}" for row in result["captureDevices"]
        )
        print("capture devices: " + (display_summary or "none"))
        for error in result["errors"]:
            print(f"ERROR: {error}", file=sys.stderr)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
