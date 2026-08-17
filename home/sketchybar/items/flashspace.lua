local flashspace = {}

flashspace.binary = "/Applications/FlashSpace.app/Contents/Resources/flashspace"

local function shell_quote(value)
    return "'" .. tostring(value):gsub("'", "'\\''") .. "'"
end

function flashspace.command(arguments)
    return shell_quote(flashspace.binary) .. " " .. arguments .. " 2>/dev/null"
end

function flashspace.parse_lines(output)
    local lines = {}

    for line in (output or ""):gmatch("[^\r\n]+") do
        if line ~= "" then
            table.insert(lines, line)
        end
    end

    return lines
end

local function run(arguments)
    local process = io.popen(flashspace.command(arguments))
    if process == nil then
        return {}
    end

    local output = process:read("*a")
    process:close()

    return flashspace.parse_lines(output)
end

function flashspace.list_workspaces()
    return run("list-workspaces")
end

function flashspace.list_active_workspaces()
    return run("list-workspaces --active")
end

function flashspace.list_running_apps(workspace)
    return flashspace.command("list-apps " .. shell_quote(workspace) .. " --only-running")
end

function flashspace.activate_workspace(workspace)
    return flashspace.command("workspace --name " .. shell_quote(workspace))
end

return flashspace
