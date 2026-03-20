# Neovim Plugin Logging Enabled

## ✅ Changes Made

I've added comprehensive logging to the Neovim plugin (`nvim/relation_window.lua`) to help debug issues like "no active session".

### **New Log File Location**

```
~/.local/share/tui-relation-window/logs/nvim.log
```

This is in the same directory as the existing `app.log` and `backend.log` files.

---

## 📝 What's Being Logged

### **1. Plugin Load**
- When the plugin loads
- Script directory and default TUI directory

### **2. M.open() - Opening a Session**
- When `M.open()` is called
- Session creation details (ID, mode, tui_dir)
- Seed context resolution (file, line, character)
- Whether the relation window started successfully
- Final session ID and active ID

### **3. M.refresh() - Refreshing Data**
- When `M.refresh()` is called
- Whether a session exists
- Whether the session is alive
- Backend payload load success/failure

### **4. M.toggle() - Toggling Window**
- When `M.toggle()` is called
- Whether closing existing session or opening new one

### **5. M.switch_mode() - Switching Modes**
- When `M.switch_mode()` is called
- Mode change (incoming ↔ outgoing)

### **6. M.set_data() - Setting Data**
- When `M.set_data()` is called
- Whether a session exists

### **7. Error Conditions**
- "no active session" warnings with context:
  - Requested ID
  - Current active ID
  - Number of sessions
- "session is not running" warnings
- "failed to start relation window" errors

---

## 🔍 How to Use the Logs

### **1. Tail the Log in Real-Time**

```bash
tail -f ~/.local/share/tui-relation-window/logs/nvim.log
```

### **2. Check Recent Activity**

```bash
tail -50 ~/.local/share/tui-relation-window/logs/nvim.log
```

### **3. Search for Errors**

```bash
grep "WARN\|ERROR" ~/.local/share/tui-relation-window/logs/nvim.log
```

### **4. Search for Specific Function Calls**

```bash
grep "M.open called" ~/.local/share/tui-relation-window/logs/nvim.log
grep "no active session" ~/.local/share/tui-relation-window/logs/nvim.log
```

---

## 🧪 Testing the Logging

### **1. Restart Neovim**

```bash
nvim
```

Check the log - you should see:
```
[2026-03-20T...] [INFO] [nvim] relation_window.lua loaded {"script_dir":"...","default_tui_dir":"..."}
```

### **2. Try to Open RelationWindow**

```vim
:edit /path/to/file.c
:RelationWindowIncoming
```

Check the log - you should see:
```
[2026-03-20T...] [INFO] [nvim] M.open called {"opts":{...}}
[2026-03-20T...] [DEBUG] [nvim] session created {"id":1,"mode":"incoming","tui_dir":"..."}
[2026-03-20T...] [DEBUG] [nvim] seed context resolved {"file":"...","line":55,"character":5}
[2026-03-20T...] [INFO] [nvim] relation window started {"id":1,"job_id":...}
[2026-03-20T...] [INFO] [nvim] M.open completed {"id":1,"active_id":1}
```

### **3. If You Get "No Active Session"**

Check the log - you should see:
```
[2026-03-20T...] [WARN] [nvim] refresh: no active session {"id":null,"active_id":null,"session_count":0}
```

This tells us:
- Which function triggered the error (`refresh`)
- What ID was requested (`null`)
- What the active ID is (`null`)
- How many sessions exist (`0`)

---

## 🐛 Debugging "No Active Session" Error

With logging enabled, when you get the "no active session" error, immediately check:

```bash
tail -20 ~/.local/share/tui-relation-window/logs/nvim.log
```

Look for:

1. **Was `M.open` called?**
   - If NO: The command didn't trigger `M.open` at all
   - If YES: Check if it completed successfully

2. **Did session creation succeed?**
   - Look for "session created" with an ID
   - Look for "relation window started" with a job_id

3. **What's the session state?**
   - Check `active_id` value
   - Check `session_count` value

4. **Was there a seed context?**
   - Look for "seed context resolved" or "no seed context available"
   - If no seed context, you might not have a valid file open

---

## 📊 Log Format

```
[TIMESTAMP] [LEVEL] [nvim] MESSAGE {JSON_METADATA}
```

Example:
```
[2026-03-20T02:46:15] [INFO] [nvim] M.open called {"opts":{"mode":"incoming","layout":"split"}}
```

- **TIMESTAMP**: ISO 8601 format
- **LEVEL**: INFO, WARN, ERROR, DEBUG
- **SOURCE**: Always `[nvim]` for Neovim plugin logs
- **MESSAGE**: Human-readable description
- **METADATA**: JSON object with relevant data

---

## 🔄 Next Steps

1. **Restart Neovim** to load the updated plugin with logging
2. **Try to reproduce the error** while tailing the log
3. **Share the log output** if you still get "no active session"

The logs will show us exactly what's happening when you try to open the RelationWindow!

---

## 📁 All Log Files

```bash
# Neovim plugin logs (NEW!)
~/.local/share/tui-relation-window/logs/nvim.log

# TUI app logs
~/.local/share/tui-relation-window/logs/app.log

# Backend logs
~/.local/share/tui-relation-window/logs/backend.log

# clangd-mcp logs (per workspace)
<workspace-root>/clangd-mcp.log
<workspace-root>/clangd-mcp-bridge.log
```

---

## 🎯 Quick Debug Command

Run this to see all recent activity across all logs:

```bash
tail -20 ~/.local/share/tui-relation-window/logs/nvim.log && \
echo "---" && \
tail -20 ~/.local/share/tui-relation-window/logs/app.log && \
echo "---" && \
tail -20 ~/.local/share/tui-relation-window/logs/backend.log
```
