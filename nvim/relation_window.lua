local M = {}

-- ── Logging ───────────────────────────────────────────────────────────────────

local LOG_DIR = vim.fn.expand("~/.local/share/tui-relation-window/logs")
local LOG_FILE = LOG_DIR .. "/nvim.log"
local BRIDGE_PREFIX = "RW_BRIDGE:"

local function ensure_log_dir()
  vim.fn.mkdir(LOG_DIR, "p")
end

local function log(level, message, meta)
  ensure_log_dir()
  local timestamp = os.date("%Y-%m-%dT%H:%M:%S")
  local meta_str = ""
  if meta then
    local ok, json = pcall(vim.json.encode, meta)
    if ok then
      meta_str = " " .. json
    else
      meta_str = " " .. vim.inspect(meta)
    end
  end
  local line = string.format("[%s] [%s] [nvim] %s%s\n", timestamp, level, message, meta_str)
  
  -- Write to file
  local file = io.open(LOG_FILE, "a")
  if file then
    file:write(line)
    file:close()
  end
end

local function log_info(message, meta)
  log("INFO", message, meta)
end

local function log_warn(message, meta)
  log("WARN", message, meta)
end

local function log_error(message, meta)
  log("ERROR", message, meta)
end

local function log_debug(message, meta)
  log("DEBUG", message, meta)
end

-- ── State ─────────────────────────────────────────────────────────────────────

-- Resolve the directory containing this script file at load time.
-- This is stable regardless of Neovim's cwd (fixes BUG-018).
local _script_dir = (debug.getinfo(1, "S").source or ""):match("^@(.+)/[^/]+$") or vim.fn.getcwd()

M.state = {
  next_id = 1,
  active_id = nil,
  sessions = {},
  -- Use the script's own directory as the default TUI dir (fixes BUG-018).
  -- nvim/relation_window.lua lives inside the tui project, so go one level up.
  default_tui_dir = vim.fn.fnamemodify(_script_dir, ":h"),
  default_mode = "both",
  backend_retries = 2,
  backend_retry_delay_ms = 250,
}

local outbox_timer = nil

log_info("relation_window.lua loaded", {
  script_dir = _script_dir,
  default_tui_dir = M.state.default_tui_dir,
})

local function is_valid_win(win)
  return win and vim.api.nvim_win_is_valid(win)
end

local function is_valid_buf(buf)
  return buf and vim.api.nvim_buf_is_valid(buf)
end

local function is_source_window(win)
  if not is_valid_win(win) then
    return false
  end

  local buf = vim.api.nvim_win_get_buf(win)
  if not is_valid_buf(buf) then
    return false
  end

  if vim.bo[buf].buftype ~= "" then
    return false
  end

  local name = vim.api.nvim_buf_get_name(buf)
  if not name or name == "" then
    return false
  end

  if name:match("^%a[%w+.-]*://") or name:match("^term://") then
    return false
  end

  return true
end

local function resolve_context_from_window(win)
  if not is_source_window(win) then
    return nil, nil, nil
  end

  local buf = vim.api.nvim_win_get_buf(win)
  local file_path = vim.api.nvim_buf_get_name(buf)
  if not file_path or file_path == "" then
    return nil, nil, nil
  end

  -- Ignore non-workspace pseudo paths and unreadable files.
  if file_path:match("^%a[%w+.-]*://") or file_path:match("^term://") then
    return nil, nil, nil
  end
  if vim.fn.filereadable(file_path) ~= 1 then
    return nil, nil, nil
  end

  local cursor = vim.api.nvim_win_get_cursor(win)
  local line = cursor[1]
  local col0 = cursor[2]
  return file_path, line, col0 + 1
end

local function find_best_source_window(exclude_win)
  local current = vim.api.nvim_get_current_win()
  if current ~= exclude_win and is_source_window(current) then
    return current
  end

  for _, win in ipairs(vim.api.nvim_list_wins()) do
    if win ~= exclude_win and is_source_window(win) then
      return win
    end
  end

  return nil
end

local function next_session_id()
  local id = M.state.next_id
  M.state.next_id = id + 1
  return id
end

local function get_session(id)
  local sid = id or M.state.active_id
  if not sid then
    return nil, nil
  end

  local session = M.state.sessions[sid]
  return sid, session
end

local function is_session_alive(session)
  if not session or not session.job_id then
    return false
  end

  return vim.fn.jobwait({ session.job_id }, 0)[1] == -1
end

local function prune_dead_sessions()
  local active_was_removed = false

  for sid, session in pairs(M.state.sessions) do
    if not is_session_alive(session) then
      M.state.sessions[sid] = nil
      if M.state.active_id == sid then
        active_was_removed = true
      end
    end
  end

  if active_was_removed then
    M.state.active_id = nil
    for sid, _ in pairs(M.state.sessions) do
      M.state.active_id = sid
      break
    end
  end
end

local function get_any_alive_session()
  prune_dead_sessions()

  local active_id = M.state.active_id
  if active_id then
    local active = M.state.sessions[active_id]
    if active and is_session_alive(active) then
      return active_id, active
    end
  end

  for sid, session in pairs(M.state.sessions) do
    if session and is_session_alive(session) then
      return sid, session
    end
  end

  return nil, nil
end

local function remove_session(sid)
  if not sid then
    return
  end
  local session = M.state.sessions[sid]
  local existed = session ~= nil
  if session and session.inbox_path then
    pcall(os.remove, session.inbox_path)
  end
  if session and session.outbox_path then
    pcall(os.remove, session.outbox_path)
  end
  M.state.sessions[sid] = nil
  if M.state.active_id == sid then
    M.state.active_id = nil
    for other_id, _ in pairs(M.state.sessions) do
      M.state.active_id = other_id
      break
    end
  end
  if existed then
    log_debug("session removed", { id = sid, active_id = M.state.active_id })
  end
end

local function send_message(session, message)
  if not is_session_alive(session) then
    log_warn("send_message dropped: session is not running", {
      id = session and session.id or nil,
      type = message and message.type or nil,
    })
    return false
  end

  local line = vim.json.encode(message) .. "\n"
  if session.inbox_path and session.inbox_path ~= "" then
    local ok, err = pcall(function()
      local file = io.open(session.inbox_path, "a")
      if not file then
        error("open_failed")
      end
      file:write(line)
      file:close()
    end)
    if ok then
      return true
    end
    log_warn("send_message inbox append failed; falling back to chansend", {
      id = session.id,
      type = message and message.type or nil,
      inbox_path = session.inbox_path,
      error = tostring(err),
    })
  end

  vim.fn.chansend(session.job_id, line)
  return true
end

local function resolve_source_context(session)
  local win = session.source_win
  if not is_source_window(win) then
    win = find_best_source_window(session.win)
    session.source_win = win
  end

  return resolve_context_from_window(win)
end

local function decode_json_maybe_mixed(raw)
  if not raw or raw == "" then
    return nil
  end

  local ok, direct = pcall(vim.json.decode, raw)
  if ok and type(direct) == "table" then
    return direct
  end

  local s, _ = raw:find("{", 1, true)
  local _, e = raw:find("}%s*$")
  if s and e and e >= s then
    local candidate = raw:sub(s, e)
    local ok2, parsed = pcall(vim.json.decode, candidate)
    if ok2 and type(parsed) == "table" then
      return parsed
    end
  end

  return nil
end

local function extract_json_candidate(raw)
  if not raw or raw == "" then
    return nil, nil
  end

  local first = raw:find("{", 1, true)
  if not first then
    return nil, nil
  end

  local depth = 0
  local in_string = false
  local escape = false

  for i = first, #raw do
    local ch = raw:sub(i, i)

    if escape then
      escape = false
    elseif ch == "\\" and in_string then
      escape = true
    elseif ch == '"' then
      in_string = not in_string
    elseif not in_string then
      if ch == "{" then
        depth = depth + 1
      elseif ch == "}" then
        depth = depth - 1
        if depth == 0 then
          return raw:sub(first, i), i
        end
      end
    end
  end

  return nil, nil
end

local function find_workspace_root_for_file(file_path)
  if not file_path or file_path == "" then
    return vim.fn.getcwd()
  end

  local dir = vim.fn.fnamemodify(file_path, ":p:h")
  local markers = {
    ".clangd-mcp-state.json",
    ".clangd-mcp.json",
    ".git",
  }

  local found = vim.fs.find(markers, {
    path = dir,
    upward = true,
    stop = vim.loop.os_homedir(),
  })[1]

  if found and found ~= "" then
    -- vim.fs.find returns the marker path itself.
    -- For file markers (.clangd-mcp-state.json, .clangd-mcp.json) the parent
    -- directory is the workspace root.
    -- For directory markers (.git) the marker IS a directory, so its parent
    -- is the workspace root — NOT the directory itself.
    -- fnamemodify(path, ":p:h") on a directory returns the directory itself
    -- (trailing slash stripped), so we must check explicitly.
    local stat = vim.loop.fs_stat(found)
    if stat and stat.type == "directory" then
      -- found is e.g. /workspace/.git — workspace root is its parent
      return vim.fn.fnamemodify(found, ":p:h:h")
    else
      -- found is e.g. /workspace/.clangd-mcp-state.json — parent is root
      return vim.fn.fnamemodify(found, ":p:h")
    end
  end

  return vim.fn.getcwd()
end

local function run_backend_once(session)
  local file_path, line, character = resolve_source_context(session)
  if file_path then
    session.last_source = {
      file_path = file_path,
      line = line,
      character = character,
    }
  end

  if (not file_path) and session.last_source then
    file_path = session.last_source.file_path
    line = session.last_source.line
    character = session.last_source.character
  end

  if not file_path then
    vim.notify("RelationWindow: source context unavailable (open a C/C++ file window first)", vim.log.levels.WARN)
    return nil, "no_source_context"
  end
  local workspace_root = find_workspace_root_for_file(file_path)

  local cmd = {
    "bun",
    "run",
    "backend",
    "--mode",
    session.mode,
    "--file",
    file_path,
    "--line",
    tostring(line),
    "--character",
    tostring(character),
    "--workspace-root",
    workspace_root,
  }

  if vim.system then
    local result = vim.system(cmd, { cwd = session.tui_dir, text = true }):wait()
    if result.code ~= 0 then
      local err = (result.stderr or ""):gsub("%s+$", "")
      vim.notify("RelationWindow backend failed: " .. err, vim.log.levels.WARN)
      return nil, "backend_nonzero"
    end

    local payload = decode_json_maybe_mixed(result.stdout or "")
    if not payload then
      vim.notify("RelationWindow: backend returned invalid JSON", vim.log.levels.ERROR)
      return nil, "backend_bad_json"
    end

    return payload, nil
  end

  local output = vim.fn.system(cmd)
  if vim.v.shell_error ~= 0 then
    vim.notify("RelationWindow backend failed: " .. output, vim.log.levels.WARN)
    return nil, "backend_nonzero"
  end

  local payload = decode_json_maybe_mixed(output)
  if not payload then
    vim.notify("RelationWindow: backend returned invalid JSON", vim.log.levels.ERROR)
    return nil, "backend_bad_json"
  end

  return payload, nil
end

local function run_backend_for_point(session, mode, file_path, line, character)
  if not file_path or file_path == "" then
    return nil, "no_file"
  end

  local workspace_root = find_workspace_root_for_file(file_path)
  local cmd = {
    "bun",
    "run",
    "backend",
    "--mode",
    mode or session.mode,
    "--file",
    file_path,
    "--line",
    tostring(line or 1),
    "--character",
    tostring(character or 1),
    "--workspace-root",
    workspace_root,
  }

  if vim.system then
    local result = vim.system(cmd, { cwd = session.tui_dir, text = true }):wait()
    if result.code ~= 0 then
      local err = (result.stderr or ""):gsub("%s+$", "")
      return nil, err ~= "" and err or "backend_nonzero"
    end
    local payload = decode_json_maybe_mixed(result.stdout or "")
    if not payload then
      return nil, "backend_bad_json"
    end
    return payload, nil
  end

  local output = vim.fn.system(cmd)
  if vim.v.shell_error ~= 0 then
    return nil, output
  end
  local payload = decode_json_maybe_mixed(output)
  if not payload then
    return nil, "backend_bad_json"
  end
  return payload, nil
end

local function run_backend_doctor_once(session)
  local file_path, line, character = resolve_source_context(session)
  if file_path then
    session.last_source = {
      file_path = file_path,
      line = line,
      character = character,
    }
  end

  if (not file_path) and session.last_source then
    file_path = session.last_source.file_path
    line = session.last_source.line
    character = session.last_source.character
  end

  if not file_path then
    vim.notify("RelationWindow: source context unavailable", vim.log.levels.WARN)
    return nil
  end
  local workspace_root = find_workspace_root_for_file(file_path)

  local cmd = {
    "bun",
    "run",
    "backend",
    "--doctor",
    "--mode",
    session.mode,
    "--file",
    file_path,
    "--line",
    tostring(line),
    "--character",
    tostring(character),
    "--workspace-root",
    workspace_root,
  }

  if vim.system then
    local result = vim.system(cmd, { cwd = session.tui_dir, text = true }):wait()
    if result.code ~= 0 then
      local err = (result.stderr or ""):gsub("%s+$", "")
      vim.notify("RelationWindow doctor failed: " .. err, vim.log.levels.ERROR)
      return nil
    end

    local payload = decode_json_maybe_mixed(result.stdout or "")
    if not payload then
      vim.notify("RelationWindow doctor returned invalid JSON", vim.log.levels.ERROR)
      return nil
    end

    return payload
  end

  local output = vim.fn.system(cmd)
  if vim.v.shell_error ~= 0 then
    vim.notify("RelationWindow doctor failed: " .. output, vim.log.levels.ERROR)
    return nil
  end

  local payload = decode_json_maybe_mixed(output)
  if not payload then
    vim.notify("RelationWindow doctor returned invalid JSON", vim.log.levels.ERROR)
    return nil
  end
  return payload
end

local function load_backend_payload(session)
  local function first_root(payload)
    if type(payload) ~= "table" or type(payload.result) ~= "table" then
      return nil, nil
    end
    for name, node in pairs(payload.result) do
      return name, node
    end
    return nil, nil
  end

  local function load_backend_payload_both()
    local file_path, line, character = resolve_source_context(session)
    if file_path then
      session.last_source = {
        file_path = file_path,
        line = line,
        character = character,
      }
    end

    if (not file_path) and session.last_source then
      file_path = session.last_source.file_path
      line = session.last_source.line
      character = session.last_source.character
    end

    if not file_path then
      return nil
    end

    local incoming, in_err = run_backend_for_point(session, "incoming", file_path, line, character)
    local outgoing, out_err = run_backend_for_point(session, "outgoing", file_path, line, character)
    if not incoming and not outgoing then
      log_warn("both-mode backend failed", { in_err = in_err, out_err = out_err })
      return nil
    end

    local in_name, in_node = first_root(incoming or {})
    local out_name, out_node = first_root(outgoing or {})
    local root_name = in_name or out_name
    if not root_name then
      return {
        mode = "both",
        provider = "clangd-mcp",
        result = {},
      }
    end

    local merged = {
      symbolKind = (in_node and in_node.symbolKind) or (out_node and out_node.symbolKind),
      filePath = (in_node and in_node.filePath) or (out_node and out_node.filePath),
      lineNumber = (in_node and in_node.lineNumber) or (out_node and out_node.lineNumber),
      character = (in_node and in_node.character) or (out_node and out_node.character),
      calledBy = (in_node and in_node.calledBy) or {},
      calls = (out_node and out_node.calls) or {},
    }

    return {
      mode = "both",
      provider = (incoming and incoming.provider) or (outgoing and outgoing.provider) or "clangd-mcp",
      result = {
        [root_name] = merged,
      },
    }
  end

  if session.mode == "both" then
    return load_backend_payload_both()
  end

  for attempt = 1, session.backend_retries + 1 do
    local payload = run_backend_once(session)
    if payload then
      return payload
    end

    if attempt <= session.backend_retries then
      vim.wait(session.backend_retry_delay_ms)
    end
  end

  return nil
end

local function open_location_in_source(session, file_path, line_number)
  local target_win = session.source_win

  if not is_source_window(target_win) then
    target_win = find_best_source_window(session.win)
    session.source_win = target_win
  end

  local lnum = tonumber(line_number) or 1

  -- Helper: open file_path in win without discarding unsaved changes (BUG-013).
  -- If the file is already loaded in some buffer, switch to it.
  -- If the current buffer in win is modified, open in a new split rather than
  -- clobbering it.
  local function open_in_win(win)
    vim.api.nvim_set_current_win(win)
    local cur_buf = vim.api.nvim_win_get_buf(win)
    local cur_name = vim.api.nvim_buf_get_name(cur_buf)

    -- Already showing the right file — just move the cursor.
    if cur_name == file_path then
      vim.api.nvim_win_set_cursor(win, { lnum, 0 })
      return
    end

    -- Check if the file is already open in any buffer.
    local existing_buf = vim.fn.bufnr(file_path)
    if existing_buf ~= -1 then
      vim.api.nvim_win_set_buf(win, existing_buf)
      vim.api.nvim_win_set_cursor(win, { lnum, 0 })
      return
    end

    -- Buffer is modified — open in a new split to avoid data loss.
    if vim.bo[cur_buf].modified then
      vim.cmd("split " .. vim.fn.fnameescape(file_path))
      vim.api.nvim_win_set_cursor(0, { lnum, 0 })
      return
    end

    -- Safe to replace the buffer in this window.
    vim.cmd("edit " .. vim.fn.fnameescape(file_path))
    vim.api.nvim_win_set_cursor(win, { lnum, 0 })
  end

  if is_source_window(target_win) then
    open_in_win(target_win)
    return
  end

  -- No source window available — open in current window.
  local cur_buf = vim.api.nvim_get_current_buf()
  if vim.bo[cur_buf].modified then
    vim.cmd("split " .. vim.fn.fnameescape(file_path))
  else
    vim.cmd("edit " .. vim.fn.fnameescape(file_path))
  end
  vim.api.nvim_win_set_cursor(0, { lnum, 0 })
end

local function handle_bridge_message(session_id, line)
  if line == nil or line == "" then
    return false
  end

  local msg = decode_json_maybe_mixed(line)
  if type(msg) ~= "table" then
    return false
  end

  local session = M.state.sessions[session_id]
  if not session then
    -- Session may already be closed while terminal output still drains.
    -- Treat as handled to avoid noisy false-positive "unhandled" warnings.
    log_debug("bridge message dropped for missing session", { session_id = session_id })
    return true
  end

  if msg.type == "open_location" and msg.payload then
    local p = msg.payload
    if p.filePath and p.lineNumber then
      open_location_in_source(session, p.filePath, p.lineNumber)
    end
    return true
  end

  if msg.type == "request_refresh" then
    M.refresh(session_id)
    return true
  end

  if msg.type == "query_relations" and msg.payload then
    local p = msg.payload
    log_debug("bridge query_relations received", {
      requestId = p.requestId,
      parentId = p.parentId,
      filePath = p.filePath,
      lineNumber = p.lineNumber,
      mode = p.mode,
    })
    local payload, err = run_backend_for_point(
      session,
      p.mode or session.mode,
      p.filePath,
      tonumber(p.lineNumber) or 1,
      tonumber(p.character) or 1
    )

    if payload then
      log_debug("bridge query_relations result", {
        requestId = p.requestId,
        parentId = p.parentId,
      })
      send_message(session, {
        type = "query_result",
        payload = {
          requestId = tostring(p.requestId or ""),
          parentId = tostring(p.parentId or ""),
          result = payload,
        },
      })
    else
      log_warn("bridge query_relations error", {
        requestId = p.requestId,
        parentId = p.parentId,
        error = err,
      })
      send_message(session, {
        type = "query_error",
        payload = {
          requestId = tostring(p.requestId or ""),
          parentId = tostring(p.parentId or ""),
          error = tostring(err or "query failed"),
        },
      })
    end
    return true
  end

  return true
end

local function trim_text(s)
  return (s or ""):gsub("^%s+", ""):gsub("%s+$", "")
end

local function poll_session_outbox(session)
  if not session or not session.outbox_path or session.outbox_path == "" then
    return
  end

  local file = io.open(session.outbox_path, "r")
  if not file then
    return
  end
  local content = file:read("*a") or ""
  file:close()

  if #content < (session.outbox_offset or 0) then
    session.outbox_offset = 0
    session.outbox_buffer = ""
  end
  if #content == (session.outbox_offset or 0) then
    return
  end

  local chunk = content:sub((session.outbox_offset or 0) + 1)
  session.outbox_offset = #content
  session.outbox_buffer = (session.outbox_buffer or "") .. chunk

  while true do
    local nl = session.outbox_buffer:find("\n", 1, true)
    if not nl then
      break
    end
    local line = trim_text(session.outbox_buffer:sub(1, nl - 1))
    session.outbox_buffer = session.outbox_buffer:sub(nl + 1)
    if line ~= "" then
      local handled = handle_bridge_message(session.id, line)
      if not handled then
        log_warn("outbox message unhandled", {
          session_id = session.id,
          preview = line:sub(1, 180),
        })
      end
    end
  end
end

local function ensure_outbox_timer()
  if outbox_timer then
    return
  end
  outbox_timer = vim.loop.new_timer()
  outbox_timer:start(40, 40, vim.schedule_wrap(function()
    local has_session = false
    for _, session in pairs(M.state.sessions) do
      if session and session.outbox_path and session.outbox_path ~= "" then
        has_session = true
        if is_session_alive(session) then
          poll_session_outbox(session)
        end
      end
    end
    if not has_session and outbox_timer then
      outbox_timer:stop()
      outbox_timer:close()
      outbox_timer = nil
    end
  end))
end

local function drain_stderr_buffer(session)
  if not session then
    return
  end

  local prefix_len = #BRIDGE_PREFIX
  while true do
    local buf = session.stderr_buffer or ""
    if buf == "" then
      break
    end

    local start_idx = buf:find(BRIDGE_PREFIX, 1, true)
    if not start_idx then
      if #buf > prefix_len then
        session.stderr_buffer = buf:sub(#buf - prefix_len + 1)
      end
      break
    end

    if start_idx > 1 then
      buf = buf:sub(start_idx)
      session.stderr_buffer = buf
    end

    local json_start = prefix_len + 1
    local json_payload = buf:sub(json_start)
    local candidate, end_idx = extract_json_candidate(json_payload)
    if not candidate or not end_idx then
      break
    end

    local handled = handle_bridge_message(session.id, candidate)
    if not handled then
      log_warn("bridge message unhandled", {
        session_id = session.id,
        preview = candidate:sub(1, 180),
      })
    end
    session.stderr_buffer = json_payload:sub(end_idx + 1)
  end
end

local function append_bridge_chunk(session, data, source)
  if not data then
    return
  end

  local chunk = table.concat(data, "")
  if chunk == "" then
    return
  end

  if chunk:find(BRIDGE_PREFIX, 1, true) then
    log_debug("bridge prefix observed", {
      session_id = session.id,
      source = source,
      bytes = #chunk,
    })
  end

  session.stderr_buffer = (session.stderr_buffer or "") .. chunk
  drain_stderr_buffer(session)
end

local function start_relation_window(session, cmd)
  if vim.fn.isdirectory(session.tui_dir) ~= 1 then
    vim.notify("RelationWindow: invalid tui_dir: " .. tostring(session.tui_dir), vim.log.levels.ERROR)
    return false
  end

  session.job_id = vim.fn.termopen(cmd, {
    cwd = session.tui_dir,
    env = {
      RW_BRIDGE_INBOX = session.inbox_path or "",
      RW_BRIDGE_OUTBOX = session.outbox_path or "",
    },
    -- In terminal/PTTY mode, Neovim may deliver stderr and stdout together
    -- via on_stdout; process both streams to keep bridge protocol reliable.
    on_stdout = function(_, data)
      append_bridge_chunk(session, data, "stdout")
    end,
    on_stderr = function(_, data)
      append_bridge_chunk(session, data, "stderr")
    end,
    on_exit = function()
      if session.stderr_buffer and session.stderr_buffer ~= "" then
        drain_stderr_buffer(session)
      end

      local sid = session.id
      local s = M.state.sessions[sid]
      if s then
        s.job_id = nil
      end
      remove_session(sid)
    end,
  })

  session.win = vim.api.nvim_get_current_win()
  session.buf = vim.api.nvim_get_current_buf()

  -- Ensure terminal relation buffer never participates in source-code LSP flows.
  pcall(vim.api.nvim_set_option_value, "filetype", "relationwindow", { buf = session.buf })
  pcall(vim.api.nvim_set_option_value, "buflisted", false, { buf = session.buf })
  pcall(vim.api.nvim_set_option_value, "swapfile", false, { buf = session.buf })
  pcall(vim.api.nvim_set_option_value, "number", false, { win = session.win })
  pcall(vim.api.nvim_set_option_value, "relativenumber", false, { win = session.win })
  pcall(vim.api.nvim_set_option_value, "signcolumn", "no", { win = session.win })

  -- Defensive: disable inlay hints and detach any accidentally attached LSP clients.
  pcall(function()
    if vim.lsp.inlay_hint and vim.lsp.inlay_hint.enable then
      vim.lsp.inlay_hint.enable(false, { bufnr = session.buf })
    end
  end)
  pcall(function()
    local clients = vim.lsp.get_clients({ bufnr = session.buf })
    for _, client in ipairs(clients) do
      vim.lsp.buf_detach_client(session.buf, client.id)
    end
  end)

  return true
end

function M.open(opts)
  opts = opts or {}
  prune_dead_sessions()
  log_info("M.open called", { opts = opts })

  local existing_id, existing = get_any_alive_session()
  if existing_id and existing then
    if opts.mode then
      existing.mode = opts.mode
    end
    if opts.tui_dir then
      existing.tui_dir = opts.tui_dir
    end
    if opts.backend_retries ~= nil then
      existing.backend_retries = math.max(0, tonumber(opts.backend_retries) or 0)
    end
    if opts.backend_retry_delay_ms ~= nil then
      existing.backend_retry_delay_ms = math.max(0, tonumber(opts.backend_retry_delay_ms) or 0)
    end

    M.state.active_id = existing_id
    log_info("M.open reusing existing session", { id = existing_id, mode = existing.mode })

    if opts.payload then
      send_message(existing, { type = "set_data", payload = opts.payload })
    else
      M.refresh(existing_id)
    end

    if is_valid_win(existing.win) then
      pcall(vim.api.nvim_set_current_win, existing.win)
      pcall(vim.cmd, "startinsert")
    elseif is_valid_buf(existing.buf) then
      -- Session is alive but its original tab/window was closed manually.
      -- Reattach the existing terminal buffer in a fresh tab.
      vim.cmd("tabnew")
      existing.win = vim.api.nvim_get_current_win()
      vim.api.nvim_win_set_buf(existing.win, existing.buf)
      pcall(vim.cmd, "startinsert")
    else
      -- Session bookkeeping is stale; fall through to create a fresh session.
      M.state.sessions[existing_id] = nil
      if M.state.active_id == existing_id then
        M.state.active_id = nil
      end
      existing_id = nil
      existing = nil
    end

    if existing_id and existing then
      return existing_id
    end
  end

  local source_win = find_best_source_window(nil) or vim.api.nvim_get_current_win()
  -- For now, enforce tab-only relation window UX.
  local layout = "tab"
  local width = opts.width or 60
  local tui_dir = opts.tui_dir or M.state.default_tui_dir
  local mode = opts.mode or M.state.default_mode
  local session = {
    id = next_session_id(),
    win = nil,
    buf = nil,
    job_id = nil,
    source_win = source_win,
    layout = layout,
    tui_dir = tui_dir,
    mode = mode,
    backend_retries = tonumber(opts.backend_retries) or M.state.backend_retries,
    backend_retry_delay_ms = tonumber(opts.backend_retry_delay_ms) or M.state.backend_retry_delay_ms,
    last_source = nil,
    stderr_buffer = "",
    inbox_path = nil,
    outbox_path = nil,
    outbox_offset = 0,
    outbox_buffer = "",
  }

  local bridge_dir = vim.fn.expand("~/.local/share/tui-relation-window/bridge")
  vim.fn.mkdir(bridge_dir, "p")
  session.inbox_path = bridge_dir .. "/session-" .. tostring(session.id) .. ".inbox"
  local inbox_file = io.open(session.inbox_path, "w")
  if inbox_file then
    inbox_file:write("")
    inbox_file:close()
  else
    log_warn("failed to create inbox file; bridge will fall back to stdin", { inbox_path = session.inbox_path, id = session.id })
    session.inbox_path = nil
  end

  session.outbox_path = bridge_dir .. "/session-" .. tostring(session.id) .. ".outbox"
  local outbox_file = io.open(session.outbox_path, "w")
  if outbox_file then
    outbox_file:write("")
    outbox_file:close()
  else
    log_warn("failed to create outbox file; app->nvim bridge may leak to UI", { outbox_path = session.outbox_path, id = session.id })
    session.outbox_path = nil
  end

  -- Disable PTY echo and export bridge file channels explicitly in shell cmd.
  -- This makes bridge transport independent of termopen() env support.
  local cmd = opts.cmd
  if not cmd then
    local inb = vim.fn.shellescape(session.inbox_path or "")
    local outb = vim.fn.shellescape(session.outbox_path or "")
    cmd = {
      "bash",
      "-lc",
      "stty -echo; RW_BRIDGE_INBOX=" .. inb .. " RW_BRIDGE_OUTBOX=" .. outb .. " bun run start",
    }
  end

  log_debug("session created", { id = session.id, mode = mode, tui_dir = tui_dir })

  local seed_file, seed_line, seed_character = resolve_context_from_window(source_win)
  if seed_file then
    session.last_source = {
      file_path = seed_file,
      line = seed_line,
      character = seed_character,
    }
    log_debug("seed context resolved", { file = seed_file, line = seed_line, character = seed_character })
  else
    log_warn("no seed context available", { source_win = source_win })
  end

  -- Always create relation split/tab from the source-code window context.
  if is_valid_win(source_win) then
    pcall(vim.api.nvim_set_current_win, source_win)
  end

  if layout == "tab" then
    vim.cmd("tabnew")
  else
    vim.cmd("botright vsplit")
    vim.cmd("vertical resize " .. tostring(width))
  end

  local started = start_relation_window(session, cmd)
  if not started then
    log_error("failed to start relation window", { id = session.id })
    if layout == "tab" then
      vim.cmd("tabclose")
    else
      vim.cmd("close")
    end
    return nil
  end

  log_info("relation window started", { id = session.id, job_id = session.job_id })

  M.state.sessions[session.id] = session
  M.state.active_id = session.id
  if session.outbox_path then
    ensure_outbox_timer()
  end

  if opts.payload then
    send_message(session, { type = "set_data", payload = opts.payload })
  else
    M.refresh(session.id)
  end

  pcall(vim.api.nvim_set_current_win, session.win)
  pcall(vim.cmd, "startinsert")

  log_info("M.open completed", { id = session.id, active_id = M.state.active_id })
  return session.id
end

function M.focus(id)
  local sid, session = get_session(id)
  if not sid or not session then
    log_warn("focus: no such session", { id = id, active_id = M.state.active_id })
    return
  end

  if is_valid_win(session.win) then
    vim.api.nvim_set_current_win(session.win)
    M.state.active_id = sid
    pcall(vim.cmd, "startinsert")
  else
    log_warn("focus: session window is closed", { id = sid })
  end
end

function M.close(id)
  local sid, session = get_session(id)
  if not sid or not session then
    log_warn("close: no session to close", { id = id, active_id = M.state.active_id })
    return
  end

  send_message(session, { type = "quit" })

  if is_valid_win(session.win) then
    vim.api.nvim_win_close(session.win, true)
  elseif is_valid_buf(session.buf) then
    vim.api.nvim_buf_delete(session.buf, { force = true })
  end

  remove_session(sid)
end

function M.close_all()
  local ids = {}
  for sid, _ in pairs(M.state.sessions) do
    table.insert(ids, sid)
  end

  for _, sid in ipairs(ids) do
    M.close(sid)
  end
end

function M.set_data(payload, id)
  log_debug("set_data called", { id = id, has_payload = payload ~= nil })
  local _, session = get_session(id)
  if not session then
    log_warn("set_data: no active session", { id = id, active_id = M.state.active_id, session_count = vim.tbl_count(M.state.sessions) })
    return
  end

  send_message(session, { type = "set_data", payload = payload })
end

function M.refresh(id)
  prune_dead_sessions()
  log_debug("refresh called", { id = id, active_id = M.state.active_id })
  local _, session = get_session(id)
  if not session then
    -- Compatibility behavior: legacy command flows call set_mode() + refresh()
    -- without opening a session first. If no active session exists, open one.
    if id == nil then
      log_info("refresh: no session, opening new one")
      M.open({
        mode = M.state.default_mode,
        tui_dir = M.state.default_tui_dir,
        backend_retries = M.state.backend_retries,
        backend_retry_delay_ms = M.state.backend_retry_delay_ms,
      })
      return
    end

    log_warn("refresh: no active session", { id = id, active_id = M.state.active_id, session_count = vim.tbl_count(M.state.sessions) })
    return
  end

  if not is_session_alive(session) then
    if id == nil then
      log_info("refresh: session not running, opening new one")
      M.open({
        mode = M.state.default_mode,
        tui_dir = M.state.default_tui_dir,
        backend_retries = M.state.backend_retries,
        backend_retry_delay_ms = M.state.backend_retry_delay_ms,
      })
      return
    end

    log_warn("refresh: session is not running", { id = id })
    return
  end

  local payload = load_backend_payload(session)
  if payload then
    send_message(session, { type = "set_data", payload = payload })
  else
    log_warn("refresh: backend payload load failed")
  end
end

local function resolve_symbol_from_source_window(session)
  local win = session and session.source_win or nil
  if not is_source_window(win) then
    win = find_best_source_window(session and session.win or nil)
    if session then
      session.source_win = win
    end
  end
  if not is_source_window(win) then
    return nil
  end

  local ok, symbol = pcall(vim.api.nvim_win_call, win, function()
    return vim.fn.expand("<cword>")
  end)
  if not ok then
    return nil
  end
  symbol = (symbol or ""):gsub("^%s+", ""):gsub("%s+$", "")
  if symbol == "" then
    return nil
  end
  return symbol
end

function M.add_custom_relation(relation_type, id)
  if relation_type ~= "incoming" and relation_type ~= "outgoing" then
    log_warn("add_custom_relation: invalid relation type", { relation_type = relation_type })
    return
  end

  local _, session = get_session(id)
  if not session then
    log_warn("add_custom_relation: no active session", { id = id, active_id = M.state.active_id })
    vim.notify("RelationWindow: no active session", vim.log.levels.WARN)
    return
  end

  local file_path, line = resolve_source_context(session)
  if not file_path then
    vim.notify("RelationWindow: source context unavailable", vim.log.levels.WARN)
    return
  end

  local symbol = resolve_symbol_from_source_window(session)
  if not symbol then
    symbol = vim.fn.fnamemodify(file_path, ":t") .. ":" .. tostring(line or 1)
  end

  local payload = {
    type = "add_custom_relation",
    payload = {
      relationType = relation_type,
      label = symbol,
      filePath = file_path,
      lineNumber = tonumber(line) or 1,
    },
  }

  send_message(session, payload)
  log_info("custom relation sent", {
    relationType = relation_type,
    label = symbol,
    filePath = file_path,
    lineNumber = tonumber(line) or 1,
  })
  vim.notify(
    string.format(
      "RelationWindow: added custom %s API '%s'",
      relation_type == "incoming" and "caller" or "callee",
      symbol
    ),
    vim.log.levels.INFO
  )
end

function M.ping(id)
  local _, session = get_session(id)
  if not session then
    log_warn("ping: no active session", { id = id, active_id = M.state.active_id })
    return
  end

  send_message(session, { type = "ping" })
end

function M.set_mode(mode, id)
  if mode ~= "incoming" and mode ~= "outgoing" and mode ~= "both" then
    log_warn("set_mode: invalid mode", { mode = mode })
    return
  end

  local _, session = get_session(id)
  if not session then
    -- Keep mode sticky so subsequent refresh() can open with this mode.
    M.state.default_mode = mode
    return
  end

  session.mode = mode
end

function M.set_backend_retry(opts, id)
  opts = opts or {}

  local _, session = get_session(id)
  if not session then
    log_warn("set_backend_retry: no active session", { id = id, active_id = M.state.active_id })
    return
  end

  if opts.retries ~= nil then
    session.backend_retries = math.max(0, tonumber(opts.retries) or 0)
  end

  if opts.delay_ms ~= nil then
    session.backend_retry_delay_ms = math.max(0, tonumber(opts.delay_ms) or 0)
  end
end

function M.list_sessions()
  local result = {}
  for sid, session in pairs(M.state.sessions) do
    table.insert(result, {
      id = sid,
      mode = session.mode,
      layout = session.layout,
      alive = is_session_alive(session),
      source_win = session.source_win,
      relation_win = session.win,
    })
  end

  table.sort(result, function(a, b)
    return a.id < b.id
  end)

  return result
end

function M.doctor(id)
  local _, session = get_session(id)
  if not session then
    log_warn("doctor: no active session", { id = id, active_id = M.state.active_id })
    return
  end

  local diag = run_backend_doctor_once(session)
  if not diag then
    return
  end

  local lines = {
    "RelationWindow doctor:",
    "connected=" .. tostring(diag.connected),
    "mcpUrl=" .. tostring(diag.mcpUrl),
    "requested=" .. tostring(diag.requestedPoint and (diag.requestedPoint.file .. ":" .. diag.requestedPoint.line .. ":" .. diag.requestedPoint.character) or "n/a"),
    "resolved=" .. tostring(diag.resolvedPoint and (diag.resolvedPoint.file .. ":" .. diag.resolvedPoint.line .. ":" .. diag.resolvedPoint.character) or "n/a"),
    "hoverFirstLine=" .. tostring(diag.hoverFirstLine),
  }

  log_info("doctor summary", { lines = lines })
end

-- Toggle: open if no alive session exists, close the active one if it does (FEAT-005).
function M.toggle(opts)
  log_info("M.toggle called", { opts = opts })
  local sid, session = get_session(nil)
  if sid and session and is_session_alive(session) then
    log_info("toggle: closing existing session", { id = sid })
    M.close(sid)
  else
    log_info("toggle: opening new session")
    M.open(opts or {})
  end
end

-- SwitchMode: flip incoming↔outgoing for the active session and refresh (FEAT-006).
function M.switch_mode(id)
  log_info("M.switch_mode called", { id = id })
  local _, session = get_session(id)
  if not session then
    log_warn("switch_mode: no active session", { id = id, active_id = M.state.active_id })
    return
  end

  local old_mode = session.mode
  session.mode = (session.mode == "incoming") and "outgoing" or "incoming"
  log_info("switch_mode: mode changed", { id = id, old_mode = old_mode, new_mode = session.mode })
  M.refresh(id)
end

-- VimResized handler: notify the TUI so it can recalculate its viewport (TD-006).
-- Sends a ping; the TUI will re-render at the new terminal size on the next tick.
vim.api.nvim_create_autocmd("VimResized", {
  group = vim.api.nvim_create_augroup("RelationWindowResize", { clear = true }),
  callback = function()
    for _, session in pairs(M.state.sessions) do
      if is_session_alive(session) then
        send_message(session, { type = "ping" })
      end
    end
  end,
})

-- Keep relation terminal buffers in terminal-input mode after mouse/window focus.
vim.api.nvim_create_autocmd({ "BufEnter", "WinEnter" }, {
  group = vim.api.nvim_create_augroup("RelationWindowFocus", { clear = true }),
  callback = function(args)
    local buf = args.buf
    if not is_valid_buf(buf) then
      return
    end
    if vim.bo[buf].buftype ~= "terminal" then
      return
    end
    for _, session in pairs(M.state.sessions) do
      if session.buf == buf and is_session_alive(session) then
        pcall(vim.cmd, "startinsert")
        break
      end
    end
  end,
})

-- If users close the relation tab/window manually, clear session bookkeeping
-- so the next open/refresh always creates a fresh, healthy session.
vim.api.nvim_create_autocmd({ "BufWipeout", "TermClose" }, {
  group = vim.api.nvim_create_augroup("RelationWindowCleanup", { clear = true }),
  callback = function(args)
    local buf = args.buf
    for sid, session in pairs(M.state.sessions) do
      if session.buf == buf then
        remove_session(sid)
        break
      end
    end
  end,
})

return M
