#!/usr/bin/env python3
"""
Clean and normalize compile_commands.json for optimal LSP indexing.

This script performs multiple cleanup operations:
1. Expands ROM/RAM patch files to include original source files
2. Removes test/mock/stub infrastructure files (optional)
3. Deduplicates entries (keeps the one with most flags)
4. Normalizes file paths (resolves symlinks, makes absolute)
5. Cleans problematic compiler flags (e.g., -mduplex)
6. Validates and reports statistics

Usage:
    python3 clean-compile-commands.py <workspace_root> [options]

Examples:
    # Basic cleanup with ROM expansion
    python3 clean-compile-commands.py /path/to/workspace

    # Remove test files and clean flags
    python3 clean-compile-commands.py /path/to/workspace --remove-tests --clean-flags

    # Dry run to see what would be changed
    python3 clean-compile-commands.py /path/to/workspace --dry-run

    # In-place update
    python3 clean-compile-commands.py /path/to/workspace --in-place
"""

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import List, Dict, Set, Optional, Tuple


class CompileCommandsCleaner:
    """Clean and normalize compile_commands.json for LSP tools."""

    def __init__(self, workspace_root: Path, verbose: bool = False):
        self.workspace_root = workspace_root.resolve()
        self.verbose = verbose
        self.stats = {
            "original_entries": 0,
            "rom_files_added": 0,
            "test_files_removed": 0,
            "duplicates_removed": 0,
            "flags_cleaned": 0,
            "paths_normalized": 0,
            "final_entries": 0,
        }

    def log(self, message: str, level: str = "INFO"):
        """Log a message if verbose mode is enabled."""
        if self.verbose or level == "ERROR":
            prefix = f"[{level}]" if level != "INFO" else ""
            print(
                f"{prefix} {message}",
                file=sys.stderr if level == "ERROR" else sys.stdout,
            )

    def load_compile_commands(self, path: Path) -> List[Dict]:
        """Load compile_commands.json."""
        self.log(f"Loading: {path}")

        if not path.exists():
            self.log(f"File does not exist: {path}", "ERROR")
            sys.exit(1)

        try:
            with open(path, "r") as f:
                entries = json.load(f)

            self.stats["original_entries"] = len(entries)
            self.log(f"  Loaded {len(entries)} entries")
            return entries
        except Exception as e:
            self.log(f"Failed to load compile_commands.json: {e}", "ERROR")
            sys.exit(1)

    def find_rom_source_file(self, patch_file: Path) -> Optional[Path]:
        """
        Find the ROM source file corresponding to a patch file.

        Mapping rules:
        - <module>/rom/*/patch/... → <module>/src/...
        - <module>/rom/*/orig/... → <module>/src/...
        - *_patch.c → *.c
        - *_patch.h → *.h
        - *patch.c → *.c (no underscore)

        Examples:
        - wlan/protocol/rom/cng_v1/patch/src/offloads/bpf_offload_int_patch.c
          → wlan/protocol/src/offloads/bpf_offload_int.c
        - wlan/mac_dp_drv/rom/cng_v1/patch/src/recv/recv_patch.c
          → wlan/mac_dp_drv/src/recv/recv.c
        - core/v1rom/patch/hwengines/copyengine/cedrvpatch.c
          → core/src/hwengines/copyengine/cedrv.c
        """
        patch_str = str(patch_file)

        # Check if this is a patch file (either *_patch.* or *patch.*)
        if "patch" not in patch_str.lower():
            return None

        # Extract the module path and relative path after 'rom/*/patch/' or 'rom/*/orig/'
        # Pattern: .../module/rom/variant/patch/...
        match = re.search(r"(.+)/rom/[^/]+/(patch|orig)/(.+)", patch_str)
        if not match:
            return None

        module_path = match.group(1)  # e.g., /path/to/wlan_proc/wlan/protocol
        relative_path = match.group(3)  # e.g., src/offloads/bpf_offload_int_patch.c

        # Remove 'patch' from the filename
        filename = Path(relative_path).name

        # Handle different patch naming patterns
        if "_patch.c" in filename:
            rom_filename = filename.replace("_patch.c", ".c")
        elif "_patch.h" in filename:
            rom_filename = filename.replace("_patch.h", ".h")
        elif "patch.c" in filename:
            # Handle cases like "cedrvpatch.c" → "cedrv.c"
            rom_filename = filename.replace("patch.c", ".c")
        elif "patch.h" in filename:
            rom_filename = filename.replace("patch.h", ".h")
        else:
            return None

        # Construct the ROM file path
        rom_relative = relative_path.replace(filename, rom_filename)

        # Try multiple possible ROM locations within the same module
        rom_candidates = [
            # Direct replacement: rom/*/patch/... → src/...
            Path(module_path) / "src" / rom_relative,
            # If relative_path already starts with 'src/', use it directly
            Path(module_path) / rom_relative,
            # Try without 'src/' prefix in relative_path
            Path(module_path)
            / "src"
            / Path(relative_path).relative_to(Path(relative_path).parts[0])
            if len(Path(relative_path).parts) > 1
            else None,
        ]

        # Filter out None values
        rom_candidates = [c for c in rom_candidates if c is not None]

        for candidate in rom_candidates:
            if candidate.exists():
                return candidate

        return None

    def create_rom_compile_entry(self, patch_entry: Dict, rom_file: Path) -> Dict:
        """Create a compile command entry for a ROM source file based on its patch file."""
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
            patch_file = patch_entry.get("file", "")
            if patch_file:
                cmd = cmd.replace(patch_file, str(rom_file.resolve()))
            rom_entry["command"] = cmd

        # Update output path if present
        if "output" in rom_entry:
            output = rom_entry["output"]
            output = output.replace("_patch.o", ".o")
            rom_entry["output"] = output

        return rom_entry

    def expand_rom_files(self, entries: List[Dict]) -> List[Dict]:
        """Expand compile_commands to include ROM source files."""
        self.log("Expanding ROM/RAM patch files...")

        rom_files_added = set()
        new_entries = []

        for entry in entries:
            file_path = entry.get("file")
            if not file_path:
                continue

            patch_file = Path(file_path)

            # Check if this is a patch file
            if "_patch." in str(patch_file):
                rom_file = self.find_rom_source_file(patch_file)

                if rom_file and rom_file not in rom_files_added:
                    rom_entry = self.create_rom_compile_entry(entry, rom_file)
                    new_entries.append(rom_entry)
                    rom_files_added.add(rom_file)

                    if len(rom_files_added) <= 5 and self.verbose:
                        self.log(f"  Mapped: {patch_file.name} → {rom_file.name}")

        self.stats["rom_files_added"] = len(new_entries)
        self.log(f"  Added {len(new_entries)} ROM source entries")

        return entries + new_entries

    def is_test_file(self, file_path: str) -> bool:
        """Check if a file is a test/mock/stub file."""
        file_lower = file_path.lower()

        # Test file patterns
        test_patterns = [
            "/test/",
            "/tests/",
            "/testing/",
            "_test.c",
            "_test.cpp",
            "_test.h",
            "test_",
            "test.c",
            "test.cpp",
            "/unit_test/",
            "/unittest/",
            "/qtf_test/",
            "_unit_test.c",
            "_unittest.c",
            "/mock/",
            "/mocks/",
            "_mock.c",
            "_mock.cpp",
            "/stub/",
            "/stubs/",
            "_stub.c",
            "_stub.cpp",
            "/simulation_test/",
            "/sim_test/",
            "/qtf_stubs/",
            "/qtf_common/",
        ]

        return any(pattern in file_lower for pattern in test_patterns)

    def remove_test_files(self, entries: List[Dict]) -> List[Dict]:
        """Remove test/mock/stub files from compile commands."""
        self.log("Removing test/mock/stub files...")

        filtered = []
        removed_count = 0

        for entry in entries:
            file_path = entry.get("file", "")
            if self.is_test_file(file_path):
                removed_count += 1
                if removed_count <= 5 and self.verbose:
                    self.log(f"  Removing: {Path(file_path).name}")
            else:
                filtered.append(entry)

        self.stats["test_files_removed"] = removed_count
        self.log(f"  Removed {removed_count} test files")

        return filtered

    def deduplicate_entries(self, entries: List[Dict]) -> List[Dict]:
        """
        Deduplicate entries for the same file.
        Keeps the entry with the most compiler flags.
        """
        self.log("Deduplicating entries...")

        # Group by file path
        file_map = defaultdict(list)
        for entry in entries:
            file_path = entry.get("file")
            if file_path:
                # Normalize path for comparison
                normalized = str(Path(file_path).resolve())
                file_map[normalized].append(entry)

        # Keep the best entry for each file
        deduplicated = []
        duplicates_removed = 0

        for file_path, file_entries in file_map.items():
            if len(file_entries) == 1:
                deduplicated.append(file_entries[0])
            else:
                # Keep the entry with the most arguments (likely most complete)
                best_entry = max(
                    file_entries, key=lambda e: len(e.get("arguments", []))
                )
                deduplicated.append(best_entry)
                duplicates_removed += len(file_entries) - 1

                if duplicates_removed <= 5 and self.verbose:
                    self.log(
                        f"  Deduplicated: {Path(file_path).name} ({len(file_entries)} → 1)"
                    )

        self.stats["duplicates_removed"] = duplicates_removed
        self.log(f"  Removed {duplicates_removed} duplicate entries")

        return deduplicated

    def clean_compiler_flags(self, entries: List[Dict]) -> List[Dict]:
        """Remove problematic compiler flags."""
        self.log("Cleaning compiler flags...")

        # Flags to remove (known to cause issues with clangd)
        problematic_flags = {
            "-mduplex",  # Hexagon-specific, not recognized by clangd
            "-Werror",  # Treat warnings as errors (too strict for indexing)
        }

        flags_cleaned = 0

        for entry in entries:
            if "arguments" in entry:
                original_args = entry["arguments"]
                cleaned_args = [
                    arg for arg in original_args if arg not in problematic_flags
                ]

                if len(cleaned_args) != len(original_args):
                    entry["arguments"] = cleaned_args
                    flags_cleaned += 1

            if "command" in entry:
                cmd = entry["command"]
                for flag in problematic_flags:
                    if flag in cmd:
                        cmd = cmd.replace(flag, "")
                        flags_cleaned += 1
                entry["command"] = cmd.strip()

        self.stats["flags_cleaned"] = flags_cleaned
        self.log(f"  Cleaned flags in {flags_cleaned} entries")

        return entries

    def normalize_paths(self, entries: List[Dict]) -> List[Dict]:
        """Normalize file paths (resolve symlinks, make absolute)."""
        self.log("Normalizing paths...")

        paths_normalized = 0

        for entry in entries:
            # Normalize file path
            if "file" in entry:
                original = entry["file"]
                try:
                    normalized = str(Path(original).resolve())
                    if normalized != original:
                        entry["file"] = normalized
                        paths_normalized += 1
                except Exception:
                    pass  # Keep original if resolution fails

            # Normalize directory path
            if "directory" in entry:
                original = entry["directory"]
                try:
                    normalized = str(Path(original).resolve())
                    if normalized != original:
                        entry["directory"] = normalized
                except Exception:
                    pass

        self.stats["paths_normalized"] = paths_normalized
        self.log(f"  Normalized {paths_normalized} paths")

        return entries

    def validate_entries(self, entries: List[Dict]) -> Tuple[List[Dict], List[str]]:
        """Validate entries and return valid ones plus error messages."""
        self.log("Validating entries...")

        valid = []
        errors = []

        for i, entry in enumerate(entries):
            # Check required fields
            if "file" not in entry:
                errors.append(f"Entry {i}: missing 'file' field")
                continue

            if "directory" not in entry:
                errors.append(f"Entry {i}: missing 'directory' field")
                continue

            if "arguments" not in entry and "command" not in entry:
                errors.append(
                    f"Entry {i}: missing both 'arguments' and 'command' fields"
                )
                continue

            # Check file exists
            file_path = Path(entry["file"])
            if not file_path.exists():
                errors.append(f"Entry {i}: file does not exist: {file_path}")
                continue

            valid.append(entry)

        if errors:
            self.log(f"  Found {len(errors)} validation errors")
            if self.verbose:
                for error in errors[:10]:  # Show first 10
                    self.log(f"    {error}")
        else:
            self.log(f"  All {len(valid)} entries are valid")

        return valid, errors

    def clean(
        self,
        input_file: Path,
        output_file: Path,
        expand_rom: bool = True,
        remove_tests: bool = False,
        deduplicate: bool = True,
        clean_flags: bool = False,
        normalize: bool = True,
        validate: bool = True,
    ) -> None:
        """
        Clean compile_commands.json with specified operations.
        """
        # Load
        entries = self.load_compile_commands(input_file)

        # Apply transformations
        if expand_rom:
            entries = self.expand_rom_files(entries)

        if remove_tests:
            entries = self.remove_test_files(entries)

        if deduplicate:
            entries = self.deduplicate_entries(entries)

        if clean_flags:
            entries = self.clean_compiler_flags(entries)

        if normalize:
            entries = self.normalize_paths(entries)

        if validate:
            entries, errors = self.validate_entries(entries)
            if errors and not self.verbose:
                self.log(f"  Run with --verbose to see validation errors")

        self.stats["final_entries"] = len(entries)

        # Write output
        self.log(f"Writing: {output_file}")
        with open(output_file, "w") as f:
            json.dump(entries, f, indent=2)

        # Print summary
        self.print_summary()

    def print_summary(self):
        """Print cleanup summary."""
        print("\n" + "=" * 60)
        print("CLEANUP SUMMARY")
        print("=" * 60)
        print(f"Original entries:       {self.stats['original_entries']:>6}")
        print(f"ROM files added:        {self.stats['rom_files_added']:>6}")
        print(f"Test files removed:     {self.stats['test_files_removed']:>6}")
        print(f"Duplicates removed:     {self.stats['duplicates_removed']:>6}")
        print(f"Flags cleaned:          {self.stats['flags_cleaned']:>6}")
        print(f"Paths normalized:       {self.stats['paths_normalized']:>6}")
        print("-" * 60)
        print(f"Final entries:          {self.stats['final_entries']:>6}")
        print("=" * 60)


def main():
    parser = argparse.ArgumentParser(
        description="Clean and normalize compile_commands.json for LSP tools",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    parser.add_argument(
        "workspace_root", type=Path, help="Root directory of the workspace"
    )

    parser.add_argument(
        "--input",
        type=Path,
        help="Input compile_commands.json (default: <workspace_root>/compile_commands.json)",
    )

    parser.add_argument(
        "--output",
        type=Path,
        help="Output file (default: <workspace_root>/compile_commands_cleaned.json)",
    )

    parser.add_argument(
        "--in-place",
        action="store_true",
        help="Overwrite the input file (creates .backup first)",
    )

    parser.add_argument(
        "--no-expand-rom", action="store_true", help="Skip ROM/RAM patch file expansion"
    )

    parser.add_argument(
        "--remove-tests", action="store_true", help="Remove test/mock/stub files"
    )

    parser.add_argument(
        "--no-deduplicate", action="store_true", help="Skip deduplication"
    )

    parser.add_argument(
        "--clean-flags",
        action="store_true",
        help="Remove problematic compiler flags (e.g., -mduplex, -Werror)",
    )

    parser.add_argument(
        "--no-normalize", action="store_true", help="Skip path normalization"
    )

    parser.add_argument("--no-validate", action="store_true", help="Skip validation")

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without writing output",
    )

    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")

    args = parser.parse_args()

    # Validate workspace root
    if not args.workspace_root.is_dir():
        print(
            f"Error: Workspace root does not exist: {args.workspace_root}",
            file=sys.stderr,
        )
        sys.exit(1)

    # Set input file
    input_file = args.input
    if input_file is None:
        input_file = args.workspace_root / "compile_commands.json"

    # Set output file
    if args.in_place:
        output_file = input_file
        # Create backup
        backup_file = input_file.with_suffix(".json.backup")
        if input_file.exists():
            import shutil

            shutil.copy2(input_file, backup_file)
            print(f"Created backup: {backup_file}")
    elif args.output:
        output_file = args.output
    else:
        output_file = args.workspace_root / "compile_commands_cleaned.json"

    if args.dry_run:
        print("DRY RUN - no files will be written")
        output_file = Path("/dev/null")

    # Create cleaner
    cleaner = CompileCommandsCleaner(args.workspace_root, verbose=args.verbose)

    # Run cleanup
    cleaner.clean(
        input_file=input_file,
        output_file=output_file,
        expand_rom=not args.no_expand_rom,
        remove_tests=args.remove_tests,
        deduplicate=not args.no_deduplicate,
        clean_flags=args.clean_flags,
        normalize=not args.no_normalize,
        validate=not args.no_validate,
    )

    if not args.dry_run and not args.in_place:
        print(f"\nTo use the cleaned compile_commands.json:")
        print(f"  cp {input_file} {input_file}.backup")
        print(f"  mv {output_file} {input_file}")
        print(f"  pkill -f 'clangd.*{args.workspace_root.name}'")


if __name__ == "__main__":
    main()
