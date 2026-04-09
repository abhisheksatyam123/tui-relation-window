#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data):
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def remove_mduplex(db_path: Path) -> int:
    data = load_json(db_path)
    removed = 0

    for entry in data:
        if isinstance(entry.get("arguments"), list):
            before = len(entry["arguments"])
            entry["arguments"] = [a for a in entry["arguments"] if a != "-mduplex"]
            removed += before - len(entry["arguments"])

        if isinstance(entry.get("command"), str) and "-mduplex" in entry["command"]:
            # conservative token-level remove
            parts = entry["command"].split()
            before = len(parts)
            parts = [p for p in parts if p != "-mduplex"]
            removed += before - len(parts)
            entry["command"] = " ".join(parts)

    save_json(db_path, data)
    return removed


def kill_pid(pid: int):
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except Exception:
        return


def is_pid_alive(pid: int) -> bool:
    if not isinstance(pid, int) or pid <= 1:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return False


def wait_dead(pids, timeout_sec: float = 6.0):
    start = time.time()
    while time.time() - start < timeout_sec:
        if not any(is_pid_alive(p) for p in pids if isinstance(p, int)):
            return True
        time.sleep(0.2)
    return False


def restart_mcp(
    workspace: Path, state: dict, mcp_project: Path, bun_bin: str, hard_reset: bool
):
    pids = []
    for key in ("httpPid", "bridgePid", "clangdPid"):
        pid = state.get(key)
        if isinstance(pid, int) and pid > 1:
            pids.append(pid)
            kill_pid(pid)

    time.sleep(1.0)
    if not wait_dead(pids, 6.0):
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except Exception:
                pass

    if hard_reset:
        for name in (".intelgraph-state.json", ".clangd-mcp-state.json"):
            state_path = workspace / name
            if state_path.exists():
                state_path.unlink()

    port = int(state.get("httpPort", 40141))
    clangd_bin = state.get("clangdBin", "/usr/local/bin/clangd-20")
    clangd_args = state.get(
        "clangdArgs", ["--background-index", "--enable-config", "--log=error"]
    )

    cmd = [
        bun_bin,
        str(mcp_project / "dist/index.js"),
        "--http-daemon",
        "--http-port",
        str(port),
        "--root",
        str(workspace),
        "--clangd",
        str(clangd_bin),
        "--clangd-args",
        ",".join(clangd_args),
    ]

    out = Path("/tmp/wlan-intelgraph-restart.out")
    err = Path("/tmp/wlan-intelgraph-restart.err")
    with (
        out.open("w", encoding="utf-8") as out_f,
        err.open("w", encoding="utf-8") as err_f,
    ):
        subprocess.Popen(cmd, stdout=out_f, stderr=err_f, start_new_session=True)

    return port


def main():
    parser = argparse.ArgumentParser(
        description="Remove -mduplex from compile_commands and restart intelgraph daemon"
    )
    parser.add_argument(
        "--workspace",
        required=True,
        help="Workspace root containing compile_commands.json",
    )
    parser.add_argument(
        "--mcp-project",
        default="/local/mnt/workspace/qprojects/intelgraph",
        help="Path to intelgraph project",
    )
    parser.add_argument(
        "--bun", default="/local/mnt/workspace/.bun/bin/bun", help="Bun binary path"
    )
    parser.add_argument(
        "--backup",
        action="store_true",
        help="Create compile_commands backup before editing",
    )
    parser.add_argument(
        "--hard-reset",
        action="store_true",
        help="Kill http/bridge/clangd and remove state before restart",
    )
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    db = workspace / "compile_commands.json"
    # Prefer the new .intelgraph-state.json, fall back to the legacy name.
    state_path = workspace / ".intelgraph-state.json"
    if not state_path.exists():
        state_path = workspace / ".clangd-mcp-state.json"

    if not db.exists():
        print(f"ERROR: Missing {db}")
        return 2
    if not state_path.exists():
        print(f"ERROR: Missing {state_path}")
        return 2

    if args.backup:
        backup = workspace / f"compile_commands.json.bak.{int(time.time())}"
        shutil.copy2(db, backup)
        print(f"Backup: {backup}")

    removed = remove_mduplex(db)
    print(f"Removed -mduplex occurrences: {removed}")

    state = load_json(state_path)
    port = restart_mcp(
        workspace, state, Path(args.mcp_project), args.bun, args.hard_reset
    )
    print(f"Restarted intelgraph daemon on port {port}")
    print(
        "Check restart logs: /tmp/wlan-intelgraph-restart.out and /tmp/wlan-intelgraph-restart.err"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
