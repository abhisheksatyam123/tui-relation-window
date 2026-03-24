#!/usr/bin/env node
/**
 * clean-compile-commands.ts
 * 
 * Standalone CLI tool to clean and normalize compile_commands.json.
 * Can also be imported as a library.
 * 
 * Usage:
 *   npx tsx scripts/clean-compile-commands.ts <workspace_root> [options]
 *   node dist/scripts/clean-compile-commands.js <workspace_root> [options]
 * 
 * Options:
 *   --remove-tests       Remove test/mock/stub files
 *   --clean-flags        Remove problematic compiler flags
 *   --in-place           Overwrite input file (creates .backup)
 *   --verbose            Detailed output
 *   --dry-run            Show what would be done without writing
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs"
import { resolve, dirname, basename, join } from "path"

interface CompileCommand {
  directory: string
  file: string
  arguments?: string[]
  command?: string
  output?: string
}

interface CleaningStats {
  originalEntries: number
  romFilesAdded: number
  testFilesRemoved: number
  duplicatesRemoved: number
  flagsCleaned: number
  pathsNormalized: number
  finalEntries: number
}

interface CleaningOptions {
  expandRom?: boolean
  removeTests?: boolean
  deduplicate?: boolean
  cleanFlags?: boolean
  normalize?: boolean
  validate?: boolean
}

class CompileCommandsCleaner {
  private workspaceRoot: string
  private verbose: boolean
  private stats: CleaningStats

  constructor(workspaceRoot: string, verbose: boolean = false) {
    this.workspaceRoot = resolve(workspaceRoot)
    this.verbose = verbose
    this.stats = {
      originalEntries: 0,
      romFilesAdded: 0,
      testFilesRemoved: 0,
      duplicatesRemoved: 0,
      flagsCleaned: 0,
      pathsNormalized: 0,
      finalEntries: 0,
    }
  }

  private log(message: string): void {
    if (this.verbose) {
      console.log(` ${message}`)
    }
  }

  /**
   * Load compile_commands.json
   */
  loadCompileCommands(path: string): CompileCommand[] {
    this.log(`Loading: ${path}`)

    if (!existsSync(path)) {
      throw new Error(`File does not exist: ${path}`)
    }

    const content = readFileSync(path, "utf8")
    const entries = JSON.parse(content) as CompileCommand[]

    this.stats.originalEntries = entries.length
    this.log(`  Loaded ${entries.length} entries`)

    return entries
  }

  /**
   * Find ROM source file corresponding to a patch file.
   * 
   * Mapping: module/rom/variant/patch/... to module/src/...
   * Patterns: file_patch.c to file.c, filepatch.c to file.c
   */
  private findRomSourceFile(patchFile: string): string | null {
    if (!patchFile.includes("patch")) {
      return null
    }

    // Extract module path and relative path after rom/variant/patch/
    const match = patchFile.match(/(.+)\/rom\/[^/]+\/(patch|orig)\/(.+)/)
    if (!match) {
      return null
    }

    const modulePath = match[1]
    const relativePath = match[3]

    // Remove 'patch' from filename
    const filename = basename(relativePath)
    let romFilename: string

    if (filename.includes("_patch.c")) {
      romFilename = filename.replace("_patch.c", ".c")
    } else if (filename.includes("_patch.h")) {
      romFilename = filename.replace("_patch.h", ".h")
    } else if (filename.includes("patch.c")) {
      romFilename = filename.replace("patch.c", ".c")
    } else if (filename.includes("patch.h")) {
      romFilename = filename.replace("patch.h", ".h")
    } else {
      return null
    }

    const romRelative = relativePath.replace(filename, romFilename)

    // Try possible ROM locations
    const candidates = [
      join(modulePath, "src", romRelative),
      join(modulePath, romRelative),
    ]

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate
      }
    }

    return null
  }

  /**
   * Create ROM compile entry from patch entry
   */
  private createRomEntry(patchEntry: CompileCommand, romFile: string): CompileCommand {
    const romEntry = { ...patchEntry }

    romEntry.file = resolve(romFile)
    romEntry.directory = dirname(resolve(romFile))

    if (romEntry.arguments) {
      romEntry.arguments = romEntry.arguments.map(arg => {
        if (arg.includes("_patch.c") || arg.includes("_patch.h") || 
            arg.includes("patch.c") || arg.includes("patch.h")) {
          return resolve(romFile)
        }
        if (arg.startsWith("-D__FILENAME__=")) {
          return `-D__FILENAME__="${basename(romFile)}"`
        }
        if (arg.startsWith("-DMY_GCC_FILE=")) {
          return `-DMY_GCC_FILE="${basename(romFile)}"`
        }
        return arg
      })
    }

    if (romEntry.command) {
      romEntry.command = romEntry.command.replace(patchEntry.file, resolve(romFile))
    }

    if (romEntry.output) {
      romEntry.output = romEntry.output
        .replace("_patch.o", ".o")
        .replace("patch.o", ".o")
    }

    return romEntry
  }

  /**
   * Expand ROM files
   */
  expandRomFiles(entries: CompileCommand[]): CompileCommand[] {
    this.log("Expanding ROM/RAM patch files...")

    const romFiles = new Set<string>()
    const newEntries: CompileCommand[] = []

    for (const entry of entries) {
      if (entry.file.includes("patch")) {
        const romFile = this.findRomSourceFile(entry.file)

        if (romFile && !romFiles.has(romFile)) {
          const romEntry = this.createRomEntry(entry, romFile)
          newEntries.push(romEntry)
          romFiles.add(romFile)

          if (romFiles.size <= 5 && this.verbose) {
            this.log(`  Mapped: ${basename(entry.file)} → ${basename(romFile)}`)
          }
        }
      }
    }

    this.stats.romFilesAdded = newEntries.length
    this.log(`  Added ${newEntries.length} ROM source entries`)

    return entries.concat(newEntries)
  }

  /**
   * Check if file is a test file
   */
  private isTestFile(filePath: string): boolean {
    const lower = filePath.toLowerCase()
    const patterns = [
      "/test/", "/tests/", "/testing/",
      "_test.c", "_test.cpp", "_test.h",
      "test_", "test.c", "test.cpp",
      "/unit_test/", "/unittest/", "/qtf_test/",
      "_unit_test.c", "_unittest.c",
      "/mock/", "/mocks/", "_mock.c", "_mock.cpp",
      "/stub/", "/stubs/", "_stub.c", "_stub.cpp",
      "/simulation_test/", "/sim_test/",
      "/qtf_stubs/", "/qtf_common/",
    ]
    return patterns.some(p => lower.includes(p))
  }

  /**
   * Remove test files
   */
  removeTestFiles(entries: CompileCommand[]): CompileCommand[] {
    this.log("Removing test/mock/stub files...")

    const beforeCount = entries.length
    const filtered = entries.filter(e => !this.isTestFile(e.file))

    this.stats.testFilesRemoved = beforeCount - filtered.length
    this.log(`  Removed ${this.stats.testFilesRemoved} test files`)

    return filtered
  }

  /**
   * Deduplicate entries
   */
  deduplicateEntries(entries: CompileCommand[]): CompileCommand[] {
    this.log("Deduplicating entries...")

    const fileMap = new Map<string, CompileCommand>()
    let duplicatesRemoved = 0

    for (const entry of entries) {
      const normalized = resolve(entry.file)
      const existing = fileMap.get(normalized)

      if (!existing) {
        fileMap.set(normalized, entry)
      } else {
        const existingArgCount = existing.arguments?.length || 0
        const newArgCount = entry.arguments?.length || 0

        if (newArgCount > existingArgCount) {
          fileMap.set(normalized, entry)
        }
        duplicatesRemoved++

        if (duplicatesRemoved <= 5 && this.verbose) {
          this.log(`  Deduplicated: ${basename(normalized)}`)
        }
      }
    }

    this.stats.duplicatesRemoved = duplicatesRemoved
    this.log(`  Removed ${duplicatesRemoved} duplicate entries`)

    return Array.from(fileMap.values())
  }

  /**
   * Clean compiler flags
   */
  cleanCompilerFlags(entries: CompileCommand[]): CompileCommand[] {
    this.log("Cleaning compiler flags...")

    const problematicFlags = new Set(["-mduplex", "-Werror"])
    let flagsCleaned = 0

    for (const entry of entries) {
      if (entry.arguments) {
        const before = entry.arguments.length
        entry.arguments = entry.arguments.filter(arg => !problematicFlags.has(arg))
        if (entry.arguments.length !== before) {
          flagsCleaned++
        }
      }

      if (entry.command) {
        let modified = false
        for (const flag of problematicFlags) {
          if (entry.command.includes(flag)) {
            entry.command = entry.command.replace(flag, "")
            modified = true
          }
        }
        if (modified) {
          entry.command = entry.command.trim()
          flagsCleaned++
        }
      }
    }

    this.stats.flagsCleaned = flagsCleaned
    this.log(`  Cleaned flags in ${flagsCleaned} entries`)

    return entries
  }

  /**
   * Normalize paths
   */
  normalizePaths(entries: CompileCommand[]): CompileCommand[] {
    this.log("Normalizing paths...")

    let pathsNormalized = 0

    for (const entry of entries) {
      if (entry.file) {
        const original = entry.file
        const normalized = resolve(original)
        if (normalized !== original) {
          entry.file = normalized
          pathsNormalized++
        }
      }

      if (entry.directory) {
        const original = entry.directory
        const normalized = resolve(original)
        if (normalized !== original) {
          entry.directory = normalized
        }
      }
    }

    this.stats.pathsNormalized = pathsNormalized
    this.log(`  Normalized ${pathsNormalized} paths`)

    return entries
  }

  /**
   * Validate entries
   */
  validateEntries(entries: CompileCommand[]): CompileCommand[] {
    this.log("Validating entries...")

    const valid: CompileCommand[] = []
    const errors: string[] = []

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]

      if (!entry.file) {
        errors.push(`Entry ${i}: missing 'file' field`)
        continue
      }

      if (!entry.directory) {
        errors.push(`Entry ${i}: missing 'directory' field`)
        continue
      }

      if (!entry.arguments && !entry.command) {
        errors.push(`Entry ${i}: missing both 'arguments' and 'command' fields`)
        continue
      }

      if (!existsSync(entry.file)) {
        errors.push(`Entry ${i}: file does not exist: ${entry.file}`)
        continue
      }

      valid.push(entry)
    }

    if (errors.length > 0) {
      this.log(`  Found ${errors.length} validation errors`)
      if (this.verbose) {
        errors.slice(0, 10).forEach(err => this.log(`    ${err}`))
      }
    } else {
      this.log(`  All ${valid.length} entries are valid`)
    }

    return valid
  }

  /**
   * Clean compile_commands.json
   */
  clean(
    inputFile: string,
    outputFile: string,
    options: CleaningOptions = {}
  ): void {
    const {
      expandRom = true,
      removeTests = false,
      deduplicate = true,
      cleanFlags = false,
      normalize = true,
      validate = true,
    } = options

    let entries = this.loadCompileCommands(inputFile)

    if (expandRom) {
      entries = this.expandRomFiles(entries)
    }

    if (removeTests) {
      entries = this.removeTestFiles(entries)
    }

    if (deduplicate) {
      entries = this.deduplicateEntries(entries)
    }

    if (cleanFlags) {
      entries = this.cleanCompilerFlags(entries)
    }

    if (normalize) {
      entries = this.normalizePaths(entries)
    }

    if (validate) {
      entries = this.validateEntries(entries)
    }

    this.stats.finalEntries = entries.length

    this.log(`Writing: ${outputFile}`)
    writeFileSync(outputFile, JSON.stringify(entries, null, 2))

    this.printSummary()
  }

  /**
   * Print summary
   */
  printSummary(): void {
    console.log("\n" + "=".repeat(60))
    console.log("CLEANUP SUMMARY")
    console.log("=".repeat(60))
    console.log(`Original entries:       ${this.stats.originalEntries.toString().padStart(6)}`)
    console.log(`ROM files added:        ${this.stats.romFilesAdded.toString().padStart(6)}`)
    console.log(`Test files removed:     ${this.stats.testFilesRemoved.toString().padStart(6)}`)
    console.log(`Duplicates removed:     ${this.stats.duplicatesRemoved.toString().padStart(6)}`)
    console.log(`Flags cleaned:          ${this.stats.flagsCleaned.toString().padStart(6)}`)
    console.log(`Paths normalized:       ${this.stats.pathsNormalized.toString().padStart(6)}`)
    console.log("-".repeat(60))
    console.log(`Final entries:          ${this.stats.finalEntries.toString().padStart(6)}`)
    console.log("=".repeat(60))
  }

  getStats(): CleaningStats {
    return { ...this.stats }
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
Usage: clean-compile-commands <workspace_root> [options]

Options:
  --input <path>        Input compile_commands.json (default: <workspace_root>/compile_commands.json)
  --output <path>       Output file (default: <workspace_root>/compile_commands_cleaned.json)
  --in-place            Overwrite input file (creates .backup)
  --no-expand-rom       Skip ROM/RAM patch file expansion
  --remove-tests        Remove test/mock/stub files
  --no-deduplicate      Skip deduplication
  --clean-flags         Remove problematic compiler flags
  --no-normalize        Skip path normalization
  --no-validate         Skip validation
  --dry-run             Show what would be done without writing
  --verbose, -v         Verbose output
  --help, -h            Show this help

Examples:
  # Basic cleanup (ROM expansion + deduplication)
  clean-compile-commands /path/to/workspace

  # Full cleanup
  clean-compile-commands /path/to/workspace --remove-tests --clean-flags --verbose

  # In-place update
  clean-compile-commands /path/to/workspace --in-place
`)
}

function main(): void {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage()
    process.exit(0)
  }

  const workspaceRoot = args[0]
  if (!existsSync(workspaceRoot)) {
    console.error(`Error: Workspace root does not exist: ${workspaceRoot}`)
    process.exit(1)
  }

  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(name)
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined
  }

  const hasFlag = (...names: string[]): boolean => {
    return names.some(name => args.includes(name))
  }

  const inputFile = getArg("--input") || join(workspaceRoot, "compile_commands.json")
  let outputFile = getArg("--output") || join(workspaceRoot, "compile_commands_cleaned.json")

  const inPlace = hasFlag("--in-place")
  const dryRun = hasFlag("--dry-run")
  const verbose = hasFlag("--verbose", "-v")

  if (inPlace) {
    outputFile = inputFile
    if (existsSync(inputFile) && !dryRun) {
      const backupFile = inputFile + ".backup"
      copyFileSync(inputFile, backupFile)
      console.log(`Created backup: ${backupFile}`)
    }
  }

  if (dryRun) {
    console.log("DRY RUN - no files will be written")
    outputFile = "/dev/null"
  }

  const cleaner = new CompileCommandsCleaner(workspaceRoot, verbose)

  cleaner.clean(inputFile, outputFile, {
    expandRom: !hasFlag("--no-expand-rom"),
    removeTests: hasFlag("--remove-tests"),
    deduplicate: !hasFlag("--no-deduplicate"),
    cleanFlags: hasFlag("--clean-flags"),
    normalize: !hasFlag("--no-normalize"),
    validate: !hasFlag("--no-validate"),
  })

  if (!dryRun && !inPlace) {
    console.log(`\nTo use the cleaned compile_commands.json:`)
    console.log(`  cp ${inputFile} ${inputFile}.backup`)
    console.log(`  mv ${outputFile} ${inputFile}`)
    console.log(`  pkill -f 'clangd.*${basename(workspaceRoot)}'`)
  }
}

// Run CLI if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}

// Export for library usage
export { CompileCommandsCleaner, type CompileCommand, type CleaningStats, type CleaningOptions }
