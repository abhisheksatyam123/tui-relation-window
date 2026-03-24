#!/usr/bin/env python3
"""
Expand compile_commands.json to include ROM source files.

The WLAN codebase uses a ROM/RAM patching mechanism where:
- ROM files contain base implementations (e.g., bpf_offload_int.c)
- Patch files override specific functions (e.g., bpf_offload_int_patch.c)
- compile_commands.json only contains patch files that are actually compiled

This script:
1. Reads existing compile_commands.json
2. For each *_patch.c file, finds the corresponding ROM source file
3. Adds a synthetic compile command for the ROM file using the patch file's flags
4. Writes an expanded compile_commands.json

Usage:
    python3 expand-compile-commands-with-rom.py <workspace_root>
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import List, Dict, Optional


def find_rom_source_file(patch_file: Path, workspace_root: Path) -> Optional[Path]:
    """
    Find the ROM source file corresponding to a patch file.

    Mapping rules:
    - rom/*/patch/src/... → protocol/src/...
    - *_patch.c → *.c
    - *_patch.h → *.h
    """
    patch_str = str(patch_file)

    # Check if this is a patch file
    if "_patch." not in patch_str:
        return None

    # Extract the relative path after 'rom/*/patch/'
    match = re.search(r"/rom/[^/]+/patch/(.+)", patch_str)
    if not match:
        return None

    relative_path = match.group(1)

    # Remove '_patch' from the filename
    filename = Path(relative_path).name
    if "_patch.c" in filename:
        rom_filename = filename.replace("_patch.c", ".c")
    elif "_patch.h" in filename:
        rom_filename = filename.replace("_patch.h", ".h")
    else:
        return None

    # Construct the ROM file path
    # rom/*/patch/src/... → protocol/src/...
    rom_relative = relative_path.replace(filename, rom_filename)

    # Try multiple possible ROM locations
    rom_candidates = [
        workspace_root / "wlan_proc" / "wlan" / "protocol" / rom_relative,
        workspace_root / "wlan_proc" / "wlan" / "protocol" / "src" / rom_relative,
    ]

    for candidate in rom_candidates:
        if candidate.exists():
            return candidate

    return None


def create_rom_compile_entry(
    patch_entry: Dict, rom_file: Path, workspace_root: Path
) -> Dict:
    """
    Create a compile command entry for a ROM source file based on its patch file.
    """
    rom_entry = patch_entry.copy()

    # Update file path
    rom_entry["file"] = str(rom_file.resolve())

    # Update directory to the ROM file's directory
    rom_entry["directory"] = str(rom_file.parent.resolve())

    # Update arguments if present
    if "arguments" in rom_entry:
        args = rom_entry["arguments"].copy()

        # Replace the source file in arguments
        for i, arg in enumerate(args):
            if "_patch.c" in arg or "_patch.h" in arg:
                args[i] = str(rom_file.resolve())
            elif arg.startswith("-D__FILENAME__="):
                args[i] = f'-D__FILENAME__="{rom_file.name}"'
            elif arg.startswith("-DMY_GCC_FILE="):
                args[i] = f'-DMY_GCC_FILE="{rom_file.name}"'

        rom_entry["arguments"] = args

    # Update command if present
    if "command" in rom_entry:
        cmd = rom_entry["command"]
        # Replace patch file references with ROM file
        patch_file = patch_entry.get("file", "")
        if patch_file:
            cmd = cmd.replace(patch_file, str(rom_file.resolve()))
        rom_entry["command"] = cmd

    # Update output path if present
    if "output" in rom_entry:
        output = rom_entry["output"]
        # Replace _patch in output path
        output = output.replace("_patch.o", ".o")
        rom_entry["output"] = output

    return rom_entry


def expand_compile_commands(
    workspace_root: Path, input_file: Path = None, output_file: Path = None
) -> None:
    """
    Expand compile_commands.json to include ROM source files.
    """
    if input_file is None:
        input_file = workspace_root / "compile_commands.json"

    if output_file is None:
        output_file = workspace_root / "compile_commands_expanded.json"

    print(f"Reading: {input_file}")

    if not input_file.exists():
        print(f"Error: Input file does not exist: {input_file}", file=sys.stderr)
        sys.exit(1)

    # Load existing compile commands
    with open(input_file, "r") as f:
        entries = json.load(f)

    print(f"  Loaded {len(entries)} entries")

    # Track ROM files we've added
    rom_files_added = set()
    new_entries = []

    # Process each entry
    for entry in entries:
        file_path = entry.get("file")
        if not file_path:
            continue

        patch_file = Path(file_path)

        # Check if this is a patch file
        if "_patch." in str(patch_file):
            # Find corresponding ROM file
            rom_file = find_rom_source_file(patch_file, workspace_root)

            if rom_file and rom_file not in rom_files_added:
                # Create a compile entry for the ROM file
                rom_entry = create_rom_compile_entry(entry, rom_file, workspace_root)
                new_entries.append(rom_entry)
                rom_files_added.add(rom_file)

                if len(rom_files_added) <= 10:  # Print first 10 for debugging
                    print(f"  Mapped: {patch_file.name} → {rom_file}")

    print(f"  Added {len(new_entries)} ROM source entries")

    # Combine original and new entries
    all_entries = entries + new_entries

    print(f"  Total entries: {len(all_entries)}")

    # Write output
    print(f"Writing: {output_file}")
    with open(output_file, "w") as f:
        json.dump(all_entries, f, indent=2)

    print("Done!")
    print(f"\nTo use the expanded compile_commands.json:")
    print(f"  mv {output_file} {workspace_root / 'compile_commands.json'}")


def main():
    parser = argparse.ArgumentParser(
        description="Expand compile_commands.json to include ROM source files"
    )
    parser.add_argument(
        "workspace_root", type=Path, help="Root directory of the WLAN workspace"
    )
    parser.add_argument(
        "--input",
        type=Path,
        help="Input compile_commands.json (default: <workspace_root>/compile_commands.json)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Output file (default: <workspace_root>/compile_commands_expanded.json)",
    )
    parser.add_argument(
        "--in-place",
        action="store_true",
        help="Overwrite the input file instead of creating a new one",
    )

    args = parser.parse_args()

    # Validate workspace root
    if not args.workspace_root.is_dir():
        print(
            f"Error: Workspace root does not exist: {args.workspace_root}",
            file=sys.stderr,
        )
        sys.exit(1)

    # Set output file
    output_file = args.output
    if args.in_place:
        if args.input:
            output_file = args.input
        else:
            output_file = args.workspace_root / "compile_commands.json"

    expand_compile_commands(
        workspace_root=args.workspace_root,
        input_file=args.input,
        output_file=output_file,
    )


if __name__ == "__main__":
    main()
