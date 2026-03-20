# Troubleshooting Guide

## Error: "RelationWindow: no active session"

This error means the TUI process is not running. This can happen for several reasons:

### 1. **You haven't opened a file yet**

The RelationWindow plugin requires you to:
1. Open a C/C++ file first
2. Place your cursor on a function name
3. Then run `:RelationWindowIncoming` or `<leader>ri`

**Solution:**
```vim
:edit /path/to/your/file.c
:normal! 55G          " Go to line 55
:RelationWindowIncoming
```

### 2. **The TUI process failed to start**

Check the logs for errors:

```bash
# Check backend logs
tail -50 ~/.local/share/tui-relation-window/logs/backend.log

# Check app logs
tail -50 ~/.local/share/tui-relation-window/logs/app.log
```

Common issues:
- **Missing `bun` runtime**: The backend requires `bun` to be installed
- **Missing `clangd`**: The backend requires `clangd-20` or `clangd` to be installed
- **Permission issues**: Check that log directory is writable

### 3. **The workspace doesn't have a compile_commands.json**

`clangd` requires a `compile_commands.json` file to understand your project structure.

**Check if it exists:**
```bash
ls -la /path/to/your/workspace/compile_commands.json
```

**If missing, generate it:**
```bash
# For CMake projects
cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON .

# For Make projects
bear -- make

# For other build systems, see: https://clangd.llvm.org/installation.html
```

### 4. **The plugin path is incorrect**

Check that the plugin is loading correctly:

```vim
:lua print(vim.inspect(package.loaded.relation_window))
```

If it returns `nil`, the plugin isn't loaded. Check:
- `~/.config/nvim/plugin/relation_window.lua` exists
- The path in that file points to the correct location

### 5. **Neovim version is too old**

The plugin requires Neovim 0.9.0 or later.

**Check your version:**
```vim
:version
```

---

## Diagnostic Commands

### `:RelationWindowDoctor`

Run the built-in diagnostic command:
```vim
:RelationWindowDoctor
```

This will check:
- Backend connectivity
- MCP daemon status
- Symbol resolution
- Workspace configuration

### `:RelationWindowSessions`

List all active sessions:
```vim
:RelationWindowSessions
```

If this shows no sessions, it means no TUI is running.

---

## Manual Test

Try running the backend manually to see if it works:

```bash
cd /local/mnt/workspace/qprojects/tui-relation-window

# Test backend directly
bun run src/backend.ts \
  --mode incoming \
  --file /path/to/your/file.c \
  --line 55 \
  --character 5 \
  --workspace-root /path/to/your/workspace
```

If this works, the backend is fine and the issue is with the Neovim integration.

---

## Common Fixes

### Fix 1: Reload Neovim configuration

```vim
:source ~/.config/nvim/init.lua
:source ~/.config/nvim/plugin/relation_window.lua
```

### Fix 2: Check file type

The plugin works best with C/C++ files. Make sure your file has the correct filetype:

```vim
:set filetype?
```

Should show `filetype=c` or `filetype=cpp`.

### Fix 3: Check workspace root detection

```vim
:lua print(vim.fn.getcwd())
```

Make sure this points to your project root (where `compile_commands.json` is).

### Fix 4: Manually specify workspace root

If auto-detection fails, you can specify it manually:

```vim
:lua require('relation_window').open({
  mode = 'incoming',
  layout = 'split',
  tui_dir = '/local/mnt/workspace/qprojects/tui-relation-window',
  workspace_root = '/path/to/your/workspace'
})
```

---

## Debug Mode

Enable verbose logging by setting environment variables before starting Neovim:

```bash
export DEBUG=1
export TUI_RELATION_LOG_LEVEL=DEBUG
nvim
```

Then check the logs again:
```bash
tail -f ~/.local/share/tui-relation-window/logs/backend.log
```

---

## Still Not Working?

1. **Check the README**: `/local/mnt/workspace/qprojects/tui-relation-window/README.md`
2. **Check the TODO**: `/local/mnt/workspace/qprojects/tui-relation-window/TODO.md`
3. **Run the test suite**:
   ```bash
   cd /local/mnt/workspace/qprojects/tui-relation-window
   bun test
   bun run test:connectivity
   ```

4. **Check clangd-mcp logs**:
   ```bash
   tail -50 /path/to/your/workspace/clangd-mcp.log
   ```

---

## Quick Start (Step-by-Step)

1. **Open Neovim with a C/C++ file:**
   ```bash
   nvim /local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1/wlan_proc/wlan_sim/tests_main/lib/timer/src/timer.c
   ```

2. **Navigate to a function:**
   ```vim
   :55    " Go to line 55 (or any line with a function)
   ```

3. **Open RelationWindow:**
   ```vim
   :RelationWindowIncoming
   ```
   Or press `<leader>ri` (where `<leader>` is `\` by default)

4. **You should see a split window** with the call hierarchy

5. **Navigate:**
   - `j`/`k` to move up/down
   - `l` or `Enter` to expand a node
   - `h` to collapse
   - `Enter` on a leaf node to jump to that location
   - `q` to close

---

## Example Session

```vim
" 1. Open a file
:edit /path/to/your/project/src/main.c

" 2. Go to a function
:55

" 3. Open incoming calls
:RelationWindowIncoming

" 4. Navigate the tree
" Press j/k to move, l to expand, Enter to jump

" 5. Switch to outgoing calls
:RelationWindowSwitchMode

" 6. Close
:RelationWindowClose
```
