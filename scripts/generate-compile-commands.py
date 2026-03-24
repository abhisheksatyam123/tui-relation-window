#!/usr/bin/env python3
"""
Generate compile_commands.json for a C/C++ project without compilation.

This script scans a source tree and generates a compile_commands.json file
by inferring compilation commands from the directory structure and existing
compile_commands.json (if present). It's useful for ensuring LSP tools like
clangd can index all source files, not just those in the current build config.

Usage:
    python3 generate-compile-commands.py <workspace_root> [--output compile_commands.json]
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import List, Dict, Set


def find_source_files(root: Path, extensions: Set[str]) -> List[Path]:
    """Find all source files with given extensions in the directory tree."""
    source_files = []

    # Directories to skip (common build/vendor directories)
    skip_dirs = {
        ".git",
        ".svn",
        ".hg",
        "build",
        "builds",
        "Build",
        "BUILD",
        "out",
        "output",
        "outputs",
        "node_modules",
        "vendor",
        "third_party",
        ".cache",
        "__pycache__",
    }

    for dirpath, dirnames, filenames in os.walk(root):
        # Skip excluded directories
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]

        for filename in filenames:
            if any(filename.endswith(ext) for ext in extensions):
                source_files.append(Path(dirpath) / filename)

    return source_files


def load_existing_compile_commands(path: Path) -> Dict[str, Dict]:
    """Load existing compile_commands.json and return a map of file -> entry."""
    if not path.exists():
        return {}

    try:
        with open(path, "r") as f:
            entries = json.load(f)

        # Create a map from file path to entry
        file_map = {}
        for entry in entries:
            if "file" in entry:
                file_map[entry["file"]] = entry

        return file_map
    except Exception as e:
        print(
            f"Warning: Failed to load existing compile_commands.json: {e}",
            file=sys.stderr,
        )
        return {}


def infer_compile_command(source_file: Path, root: Path, template: Dict = None) -> Dict:
    """Infer a compilation command for a source file."""
    abs_file = source_file.resolve()

    # If we have a template from existing compile_commands, use it as a base
    if template:
        # Clone the template and update file-specific fields
        entry = template.copy()
        entry["file"] = str(abs_file)

        # Update the directory to be the source file's directory
        entry["directory"] = str(source_file.parent.resolve())

        # Update arguments if present
        if "arguments" in entry:
            args = entry["arguments"].copy()
            # Replace the source file in arguments
            for i, arg in enumerate(args):
                if arg.endswith((".c", ".cpp", ".cc", ".cxx", ".C")):
                    args[i] = str(abs_file)
                    break
            entry["arguments"] = args

        # Update command if present
        if "command" in entry:
            # Simple replacement - just update the file path
            entry["command"] = entry["command"].replace(
                template.get("file", ""), str(abs_file)
            )

        return entry

    # No template - create a minimal entry
    # Determine compiler based on file extension
    if source_file.suffix in {".cpp", ".cc", ".cxx", ".C"}:
        compiler = "g++"
    else:
        compiler = "gcc"

    # Find include directories (look for common patterns)
    include_dirs = []
    current = source_file.parent

    # Look for 'include' directories up to 3 levels up
    for _ in range(3):
        include_candidate = current / "include"
        if include_candidate.is_dir():
            include_dirs.append(f"-I{include_candidate}")

        if current == root:
            break
        current = current.parent

    # Add the source file's directory as an include path
    include_dirs.append(f"-I{source_file.parent}")

    return {
        "directory": str(source_file.parent.resolve()),
        "file": str(abs_file),
        "arguments": [
            compiler,
            "-c",
            *include_dirs,
            "-o",
            "/dev/null",  # Dummy output
            str(abs_file),
        ],
    }


def generate_compile_commands(
    root: Path,
    existing_compile_commands: Path = None,
    output: Path = None,
    extensions: Set[str] = None,
) -> None:
    """Generate a complete compile_commands.json for all source files."""

    if extensions is None:
        extensions = {".c", ".cpp", ".cc", ".cxx", ".C"}

    print(f"Scanning source tree: {root}")

    # Load existing compile_commands if present
    existing_map = {}
    if existing_compile_commands and existing_compile_commands.exists():
        print(f"Loading existing compile_commands.json: {existing_compile_commands}")
        existing_map = load_existing_compile_commands(existing_compile_commands)
        print(f"  Found {len(existing_map)} existing entries")

    # Find all source files
    print(f"Finding source files with extensions: {extensions}")
    source_files = find_source_files(root, extensions)
    print(f"  Found {len(source_files)} source files")

    # Pick a template from existing entries (prefer one with many flags)
    template = None
    if existing_map:
        # Find an entry with the most arguments (likely has the most complete flags)
        template = max(existing_map.values(), key=lambda e: len(e.get("arguments", [])))
        print(f"  Using template from: {template.get('file', 'unknown')}")

    # Generate entries for all source files
    entries = []
    new_count = 0

    for source_file in source_files:
        abs_path = str(source_file.resolve())

        # If file already has an entry, keep it
        if abs_path in existing_map:
            entries.append(existing_map[abs_path])
        else:
            # Generate a new entry
            entry = infer_compile_command(source_file, root, template)
            entries.append(entry)
            new_count += 1

    print(f"Generated {new_count} new entries")
    print(f"Total entries: {len(entries)}")

    # Write output
    if output is None:
        output = root / "compile_commands.json"

    print(f"Writing to: {output}")
    with open(output, "w") as f:
        json.dump(entries, f, indent=2)

    print("Done!")


def main():
    parser = argparse.ArgumentParser(
        description="Generate compile_commands.json for a C/C++ project without compilation"
    )
    parser.add_argument(
        "workspace_root", type=Path, help="Root directory of the workspace to scan"
    )
    parser.add_argument(
        "--existing",
        type=Path,
        help="Path to existing compile_commands.json to use as a base (default: <workspace_root>/compile_commands.json)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Output path for generated compile_commands.json (default: <workspace_root>/compile_commands.json)",
    )
    parser.add_argument(
        "--extensions",
        nargs="+",
        default=[".c", ".cpp", ".cc", ".cxx", ".C"],
        help="File extensions to include (default: .c .cpp .cc .cxx .C)",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Print statistics without writing output"
    )

    args = parser.parse_args()

    # Validate workspace root
    if not args.workspace_root.is_dir():
        print(
            f"Error: Workspace root does not exist: {args.workspace_root}",
            file=sys.stderr,
        )
        sys.exit(1)

    # Set defaults
    if args.existing is None:
        args.existing = args.workspace_root / "compile_commands.json"

    if args.output is None:
        args.output = args.workspace_root / "compile_commands.json"

    # Convert extensions to set
    extensions = set(args.extensions)

    # Generate
    if args.dry_run:
        print("DRY RUN - no files will be written")
        # TODO: Implement dry-run mode

    generate_compile_commands(
        root=args.workspace_root,
        existing_compile_commands=args.existing,
        output=args.output,
        extensions=extensions,
    )


if __name__ == "__main__":
    main()
