local plugin = dofile(vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h:h") .. "/nvim/relation_window.lua")

local commands_registered = false
local setup_open_opts = {}
local keymaps_registered = false

local function has_active_session()
  local sid = plugin.state.active_id
  if not sid then
    return false
  end

  local session = plugin.state.sessions[sid]
  if not session or not session.job_id then
    return false
  end

  return vim.fn.jobwait({ session.job_id }, 0)[1] == -1
end

local function ensure_open(mode)
  if has_active_session() then
    plugin.set_mode(mode)
    plugin.refresh()
    return
  end

  local opts = vim.tbl_extend("force", setup_open_opts, { mode = mode })
  plugin.open(opts)
end

local function register_commands()
  if commands_registered then
    return
  end

  vim.api.nvim_create_user_command("RelationWindowIncoming", function()
    ensure_open("incoming")
  end, {})

  vim.api.nvim_create_user_command("RelationWindowOutgoing", function()
    ensure_open("outgoing")
  end, {})

  vim.api.nvim_create_user_command("RelationWindowBoth", function()
    ensure_open("both")
  end, {})

  vim.api.nvim_create_user_command("RelationWindowToggle", function()
    plugin.toggle(setup_open_opts)
  end, {})

  vim.api.nvim_create_user_command("RelationWindowSwitchMode", function()
    if has_active_session() then
      plugin.switch_mode()
      return
    end

    plugin.open(setup_open_opts)
  end, {})

  vim.api.nvim_create_user_command("RelationWindowAddCaller", function()
    plugin.add_custom_relation("incoming")
  end, {})

  vim.api.nvim_create_user_command("RelationWindowAddCallee", function()
    plugin.add_custom_relation("outgoing")
  end, {})

  commands_registered = true
end

local function register_keymaps(opts)
  if keymaps_registered then
    return
  end
  if opts and opts.default_keymaps == false then
    return
  end

  vim.keymap.set("n", "<leader>rb", "<cmd>RelationWindowBoth<cr>", {
    desc = "RelationWindow: Both",
    silent = true,
  })
  keymaps_registered = true
end

function plugin.setup(opts)
  opts = opts or {}

  if opts.tui_dir then
    plugin.state.default_tui_dir = opts.tui_dir
  end
  if opts.mode then
    plugin.state.default_mode = opts.mode
  end
  if opts.backend_retries ~= nil then
    plugin.state.backend_retries = math.max(0, tonumber(opts.backend_retries) or 0)
  end
  if opts.backend_retry_delay_ms ~= nil then
    plugin.state.backend_retry_delay_ms = math.max(0, tonumber(opts.backend_retry_delay_ms) or 0)
  end

  setup_open_opts = {
    layout = opts.layout,
    width = opts.width,
    tui_dir = opts.tui_dir,
    mode = opts.mode,
    backend_retries = opts.backend_retries,
    backend_retry_delay_ms = opts.backend_retry_delay_ms,
    cmd = opts.cmd,
  }

  register_commands()
  register_keymaps(opts)
end

return plugin
