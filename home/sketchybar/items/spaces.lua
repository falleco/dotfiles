local colors = require("colors")
local icons = require("icons")
local settings = require("settings")
local app_icons = require("helpers.app_icons")
local flashspace = require("items.flashspace")

sbar.add("event", "flashspace_workspace_change")

local spaces = {}
local workspaces = flashspace.list_workspaces()

local function to_set(values)
    local result = {}
    for _, value in ipairs(values) do
        result[value] = true
    end
    return result
end

local active_workspaces = to_set(flashspace.list_active_workspaces())

local function update_apps(index, workspace)
    sbar.exec(flashspace.list_running_apps(workspace), function(output)
        local icon_line = ""
        local seen = {}

        for _, app_name in ipairs(flashspace.parse_lines(output)) do
            if not seen[app_name] then
                seen[app_name] = true
                icon_line = icon_line .. " " .. (app_icons[app_name] or app_icons.default)
            end
        end

        if icon_line == "" then
            icon_line = " —"
        end

        sbar.animate("tanh", 10, function()
            spaces[index]:set({ label = icon_line })
        end)
    end)
end

local function update_selection()
    sbar.exec(flashspace.command("list-workspaces --active"), function(output)
        active_workspaces = to_set(flashspace.parse_lines(output))

        for index, workspace in ipairs(workspaces) do
            local selected = active_workspaces[workspace] == true
            spaces[index]:set({
                icon = { highlight = selected },
                label = { highlight = selected },
                background = {
                    border_color = selected and settings.items.highlight_color(index)
                        or settings.items.default_color(index)
                }
            })
        end
    end)
end

local function update_all_apps()
    for index, workspace in ipairs(workspaces) do
        update_apps(index, workspace)
    end
end

for index, workspace in ipairs(workspaces) do
    local selected = active_workspaces[workspace] == true
    local space = sbar.add("item", "item." .. index, {
        icon = {
            font = { family = settings.font.numbers },
            string = workspace,
            padding_left = settings.items.padding.left,
            padding_right = settings.items.padding.left / 2,
            color = settings.items.default_color(index),
            highlight_color = settings.items.highlight_color(index),
            highlight = selected
        },
        label = {
            padding_right = settings.items.padding.right,
            color = settings.items.default_color(index),
            highlight_color = settings.items.highlight_color(index),
            font = settings.icons,
            y_offset = -1,
            highlight = selected
        },
        padding_right = 1,
        padding_left = 1,
        background = {
            color = settings.items.colors.background,
            border_width = 1,
            height = settings.items.height,
            border_color = selected and settings.items.highlight_color(index) or settings.items.default_color(index)
        },
        popup = {
            background = {
                border_width = 5,
                border_color = colors.black
            }
        }
    })

    spaces[index] = space
    update_apps(index, workspace)

    sbar.add("item", "item." .. index .. "padding", {
        script = "",
        width = settings.items.gap
    })

    local space_popup = sbar.add("item", {
        position = "popup." .. space.name,
        padding_left = 5,
        padding_right = 0,
        background = {
            drawing = true,
            image = {
                corner_radius = 9,
                scale = 0.2
            }
        }
    })

    space:subscribe("mouse.clicked", function(env)
        if env.BUTTON == "other" then
            space_popup:set({
                background = { image = space.name }
            })
            space:set({ popup = { drawing = "toggle" } })
        else
            sbar.exec(flashspace.activate_workspace(workspace))
        end
    end)

    space:subscribe("mouse.exited", function()
        space:set({ popup = { drawing = false } })
    end)
end

local space_observer = sbar.add("item", {
    drawing = false,
    updates = true
})

space_observer:subscribe("flashspace_workspace_change", function()
    update_selection()
    update_all_apps()
end)

space_observer:subscribe({ "space_windows_change", "system_woke", "forced" }, function()
    update_selection()
    update_all_apps()
end)

local spaces_indicator = sbar.add("item", {
    padding_left = -3,
    padding_right = 0,
    icon = {
        padding_left = 8,
        padding_right = 9,
        color = colors.grey,
        string = icons.switch.on
    },
    label = {
        width = 0,
        padding_left = 0,
        padding_right = 8,
        string = "Spaces",
        color = colors.bg1
    },
    background = {
        color = colors.with_alpha(colors.grey, 0.0),
        border_color = colors.with_alpha(colors.bg1, 0.0)
    }
})

spaces_indicator:subscribe("swap_menus_and_spaces", function()
    local currently_on = spaces_indicator:query().icon.value == icons.switch.on
    spaces_indicator:set({
        icon = currently_on and icons.switch.off or icons.switch.on
    })
end)

spaces_indicator:subscribe("mouse.entered", function()
    sbar.animate("tanh", 30, function()
        spaces_indicator:set({
            background = {
                color = { alpha = 1.0 },
                border_color = { alpha = 1.0 }
            },
            icon = { color = colors.bg1 },
            label = { width = "dynamic" }
        })
    end)
end)

spaces_indicator:subscribe("mouse.exited", function()
    sbar.animate("tanh", 30, function()
        spaces_indicator:set({
            background = {
                color = { alpha = 0.0 },
                border_color = { alpha = 0.0 }
            },
            icon = { color = colors.grey },
            label = { width = 0 }
        })
    end)
end)

spaces_indicator:subscribe("mouse.clicked", function()
    sbar.trigger("swap_menus_and_spaces")
end)
