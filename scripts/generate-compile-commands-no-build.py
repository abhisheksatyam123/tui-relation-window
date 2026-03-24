#!/usr/bin/env python3
"""
Generate compile_commands.json without compilation.

This script scans a source tree and generates compile_commands.json by:
1. Finding all C/C++ source files
2. Inferring include paths from directory structure
3. Using a template from existing compile_commands.json (if available)
4. Creating synthetic compilation commands

This is useful when:
- You don't want to run a full build
- The build system is complex or broken
- You want to index all source files, not just those in current build config

Usage:
    python3 generate-compile-commands-no-build.py <workspace_root> [options]

Examples:
    # Generate from scratch
    python3 generate-compile-commands-no-build.py /path/to/workspace

    # Use existing compile_commands as template
    python3 generate-compile-commands-no-build.py /path/to/workspace --template compile_commands.json

    # Specify compiler and flags
    python3 generate-compile-commands-no-build.py /path/to/workspace --compiler gcc --flags "-std=c11 -Wall"
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import List, Dict, Set, Optional


class CompileCommandsGenerator:
    """Generate compile_commands.json without compilation."""

    def __init__(
        self,
        workspace_root: Path,
        compiler: str = "gcc",
        cxx_compiler: str = "g++",
        flags: List[str] = None,
        verbose: bool = False,
    ):
        self.workspace_root = workspace_root.resolve()
        self.compiler = compiler
        self.cxx_compiler = cxx_compiler
        self.flags = flags or []
        self.verbose = verbose
        self.stats = {
            "source_files_found": 0,
            "include_dirs_found": 0,
            "entries_generated": 0,
        }

    def log(self, message: str):
        """Log a message if verbose mode is enabled."""
        if self.verbose:
            print(message)

    def find_source_files(self, extensions: Set[str]) -> List[Path]:
        """Find all source files with given extensions."""
        self.log(f"Scanning for source files in: {self.workspace_root}")

        source_files = []

        # Directories to skip
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
            "rom",  # Skip ROM directories (we'll add them via patch mapping)
        }

        for dirpath, dirnames, filenames in os.walk(self.workspace_root):
            # Skip excluded directories
            dirnames[:] = [d for d in dirnames if d not in skip_dirs]

            for filename in filenames:
                if any(filename.endswith(ext) for ext in extensions):
                    source_files.append(Path(dirpath) / filename)

        self.stats["source_files_found"] = len(source_files)
        self.log(f"  Found {len(source_files)} source files")

        return source_files

    def find_include_directories(self) -> List[Path]:
        """Find all include directories in the workspace."""
        self.log("Finding include directories...")

        include_dirs = set()

        # Common include directory names
        include_names = {"include", "inc", "includes", "headers"}

        for dirpath, dirnames, _ in os.walk(self.workspace_root):
            # Check if this directory is an include directory
            dir_name = Path(dirpath).name
            if dir_name in include_names:
                include_dirs.add(Path(dirpath))

            # Also add directories that contain header files
            for dirname in dirnames:
                if dirname in include_names:
                    include_dirs.add(Path(dirpath) / dirname)

        self.stats["include_dirs_found"] = len(include_dirs)
        self.log(f"  Found {len(include_dirs)} include directories")

        return sorted(include_dirs)

    def load_template(self, template_path: Path) -> Optional[Dict]:
        """Load a template entry from existing compile_commands.json."""
        if not template_path.exists():
            return None

        self.log(f"Loading template from: {template_path}")

        try:
            with open(template_path, "r") as f:
                entries = json.load(f)

            if not entries:
                return None

            # Find the entry with the most arguments (likely most complete)
            template = max(entries, key=lambda e: len(e.get("arguments", [])))
            self.log(f"  Using template from: {template.get('file', 'unknown')}")

            return template
        except Exception as e:
            self.log(f"  Warning: Failed to load template: {e}")
            return None

    def create_compile_entry(
        self,
        source_file: Path,
        include_dirs: List[Path],
        template: Optional[Dict] = None,
    ) -> Dict:
        """Create a compile command entry for a source file."""

        abs_file = source_file.resolve()

        # Determine compiler
        if source_file.suffix in {".cpp", ".cc", ".cxx", ".C"}:
            compiler = self.cxx_compiler
        else:
            compiler = self.compiler

        # Build arguments
        if template and "arguments" in template:
            # Use template arguments as base
            args = []

            # Copy compiler and basic flags from template
            for arg in template["arguments"]:
                # Skip file-specific arguments
                if arg.endswith((".c", ".cpp", ".cc", ".cxx", ".C", ".o")):
                    continue
                if arg.startswith("-D__FILENAME__=") or arg.startswith(
                    "-DMY_GCC_FILE="
                ):
                    continue
                if arg == "-o":
                    continue

                args.append(arg)

            # Ensure compiler is first
            if args and not args[0].endswith(("gcc", "g++", "clang", "clang++")):
                args.insert(0, compiler)
            elif not args:
                args.append(compiler)
        else:
            # Create from scratch
            args = [compiler, "-c"]
            args.extend(self.flags)

        # Add include directories
        for inc_dir in include_dirs:
            inc_arg = f"-I{inc_dir}"
            if inc_arg not in args:
                args.append(inc_arg)

        # Add source file's directory as include path
        source_dir_inc = f"-I{source_file.parent}"
        if source_dir_inc not in args:
            args.append(source_dir_inc)

        # Add output and source file
        args.extend(["-o", "/dev/null", str(abs_file)])

        return {
            "directory": str(source_file.parent.resolve()),
            "file": str(abs_file),
            "arguments": args,
        }

    def generate(
        self,
        output_file: Path,
        template_file: Optional[Path] = None,
        extensions: Set[str] = None,
    ) -> None:
        """Generate compile_commands.json."""

        if extensions is None:
            extensions = {".c", ".cpp", ".cc", ".cxx", ".C"}

        # Load template if provided
        template = None
        if template_file:
            template = self.load_template(template_file)

        # Find source files
        source_files = self.find_source_files(extensions)

        # Find include directories
        include_dirs = self.find_include_directories()

        # Generate entries
        self.log("Generating compile commands...")
        entries = []

        for source_file in source_files:
            entry = self.create_compile_entry(source_file, include_dirs, template)
            entries.append(entry)

        self.stats["entries_generated"] = len(entries)

        # Write output
        self.log(f"Writing to: {output_file}")
        with open(output_file, "w") as f:
            json.dump(entries, f, indent=2)

        # Print summary
        self.print_summary()

    def print_summary(self):
        """Print generation summary."""
        print("\n" + "=" * 60)
        print("GENERATION SUMMARY")
        print("=" * 60)
        print(f"Source files found:     {self.stats['source_files_found']:>6}")
        print(f"Include dirs found:     {self.stats['include_dirs_found']:>6}")
        print(f"Entries generated:      {self.stats['entries_generated']:>6}")
        print("=" * 60)


def main():
    parser = argparse.ArgumentParser(
        description="Generate compile_commands.json without compilation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    parser.add_argument(
        "workspace_root", type=Path, help="Root directory of the workspace"
    )

    parser.add_argument(
        "--output",
        type=Path,
        help="Output file (default: <workspace_root>/compile_commands.json)",
    )

    parser.add_argument(
        "--template",
        type=Path,
        help="Existing compile_commands.json to use as template",
    )

    parser.add_argument(
        "--compiler", default="gcc", help="C compiler to use (default: gcc)"
    )

    parser.add_argument(
        "--cxx-compiler", default="g++", help="C++ compiler to use (default: g++)"
    )

    parser.add_argument(
        "--flags",
        nargs="+",
        default=[],
        help="Additional compiler flags (e.g., -std=c11 -Wall)",
    )

    parser.add_argument(
        "--extensions",
        nargs="+",
        default=[".c", ".cpp", ".cc", ".cxx", ".C"],
        help="File extensions to include (default: .c .cpp .cc .cxx .C)",
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

    # Set output file
    output_file = args.output
    if output_file is None:
        output_file = args.workspace_root / "compile_commands.json"

    # Create generator
    generator = CompileCommandsGenerator(
        workspace_root=args.workspace_root,
        compiler=args.compiler,
        cxx_compiler=args.cxx_compiler,
        flags=args.flags,
        verbose=args.verbose,
    )

    # Generate
    generator.generate(
        output_file=output_file,
        template_file=args.template,
        extensions=set(args.extensions),
    )

    print(f"\nGenerated: {output_file}")
    print(f"\nNext steps:")
    print(f"  1. Review the generated compile_commands.json")
    print(
        f"  2. Optionally clean it: python3 scripts/clean-compile-commands.py {args.workspace_root}"
    )
    print(f"  3. Restart clangd: pkill -f 'clangd.*{args.workspace_root.name}'")


if __name__ == "__main__":
    main()
