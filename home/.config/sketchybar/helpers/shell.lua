local shell = {}

function shell.quote(value)
    return "'" .. tostring(value):gsub("'", "'\\''") .. "'"
end

return shell
