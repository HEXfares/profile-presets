local json       = require("json")
local logger     = require("logger")
local millennium = require("millennium")
local fs         = require("fs")
local http       = require("http")
local utils      = require("utils")

local function get_presets_dir()
    return millennium.get_install_path() .. "/presets"
end

local function account_dir(safe_steam_id)
    return get_presets_dir() .. "/" .. safe_steam_id
end

local function preset_dir(safe_steam_id, safe_name)
    return account_dir(safe_steam_id) .. "/" .. safe_name
end

local function preset_path(safe_steam_id, safe_name)
    return preset_dir(safe_steam_id, safe_name) .. "/preset.json"
end

local function avatar_path(safe_steam_id, safe_name)
    return preset_dir(safe_steam_id, safe_name) .. "/avatar.b64"
end

local function screenshot_path(safe_steam_id, safe_name)
    return preset_dir(safe_steam_id, safe_name) .. "/screenshot.jpg.b64"
end

local function sanitize(name)
    local s = name:gsub("[^%w%s%-_]", ""):gsub("%s+", "_")
    return s:sub(1, 64)
end

local function sanitize_steam_id(steam_id)
    local raw = tostring(steam_id or "")
    local s   = raw:gsub("[^%w]", "")
    if s == "" then
        return "unknown"
    end
    return s:sub(1, 32)
end

local function ensure_dir(dir)
    if fs.is_directory(dir) then return end
    local ok, err = fs.create_directories(dir)
    if not ok and not fs.is_directory(dir) then error("Cannot create preset directory: " .. tostring(err)) end
end

local function remove_dir(dir)
    local removed, err = fs.remove_all(dir)
    if removed == nil then error("Cannot remove preset directory: " .. tostring(err)) end
end

local function write_file(path, content)
    local parent = path:match("^(.+)/[^/]+$") or get_presets_dir()
    ensure_dir(parent)
    local f, err = io.open(path, "w")
    if not f then
        return false, "Cannot open for write: " .. (err or "unknown") .. " [" .. path .. "]"
    end
    local written, write_err = f:write(content)
    local closed, close_err = f:close()
    if not written or not closed then return false, tostring(write_err or close_err or "Write failed") end
    return true
end

local function read_file(path)
    local f = io.open(path, "r")
    if not f then return nil end
    local content = f:read("*a")
    f:close()
    return content
end

local function file_exists(path)
    local f = io.open(path, "r")
    if f then f:close(); return true end
    return false
end

local function delete_file(path)
    os.remove(path)
end

local function index_path(safe_steam_id)
    return account_dir(safe_steam_id) .. "/index.json"
end

local function load_index(safe_steam_id)
    local content = read_file(index_path(safe_steam_id))
    if not content then return {} end
    local ok, data = pcall(json.decode, content)
    if not ok or type(data) ~= "table" then return {} end
    return data
end

local function save_index(safe_steam_id, index)
    ensure_dir(account_dir(safe_steam_id))
    write_file(index_path(safe_steam_id), json.encode(index))
end

local function index_add(safe_steam_id, safe_name)
    local index = load_index(safe_steam_id)
    for _, n in ipairs(index) do
        if n == safe_name then return end
    end
    table.insert(index, safe_name)
    save_index(safe_steam_id, index)
end

local function legacy_index_path()
    return get_presets_dir() .. "/index.json"
end

local function migration_marker_path()
    return get_presets_dir() .. "/.migrated_v2"
end

local function migrate_legacy_presets()
    if file_exists(migration_marker_path()) then
        return
    end

    local content = read_file(legacy_index_path())
    if not content then
        write_file(migration_marker_path(), "1")
        return
    end

    local ok, legacy_names = pcall(json.decode, content)
    if not ok or type(legacy_names) ~= "table" then
        write_file(migration_marker_path(), "1")
        return
    end

    local moved, unknown_count = 0, 0

    for _, safe_name in ipairs(legacy_names) do
        local old_dir         = get_presets_dir() .. "/" .. safe_name
        local old_preset_path = old_dir .. "/preset.json"
        local old_avatar_path = old_dir .. "/avatar.b64"

        local preset_content = read_file(old_preset_path)
        if preset_content then
            local pok, data = pcall(json.decode, preset_content)
            if pok and type(data) == "table" then
                local safe_steam_id      = sanitize_steam_id(data.steamId)
                local target_preset_path = preset_path(safe_steam_id, safe_name)

                if not file_exists(target_preset_path) then
                    local w_ok = write_file(target_preset_path, preset_content)
                    if w_ok then
                        if file_exists(old_avatar_path) then
                            local av = read_file(old_avatar_path)
                            if av then
                                write_file(avatar_path(safe_steam_id, safe_name), av)
                            end
                        end
                        index_add(safe_steam_id, safe_name)
                        moved = moved + 1
                        if safe_steam_id == "unknown" then
                            unknown_count = unknown_count + 1
                            logger:warn("Profile Presets migration: '" .. safe_name ..
                                "' had no steamId on file; moved to presets/unknown/ for manual review")
                        end
                    else
                        logger:error("Profile Presets migration: failed to write " .. target_preset_path)
                    end
                end
            end
        end

        delete_file(old_preset_path)
        delete_file(old_avatar_path)
        os.remove(old_dir)
    end

    delete_file(legacy_index_path())
    write_file(migration_marker_path(), "1")

    logger:info("Profile Presets migration complete: " .. moved .. " preset(s) moved" ..
        (unknown_count > 0 and (", " .. unknown_count .. " under presets/unknown/ (no steamId on file)") or ""))
end

function FetchScreenshotAsset(url)
    local success, result = pcall(function()
        if type(url) ~= "string" or #url > 4096 or url:find("[%c%s]") then
            return json.encode({ success = false, error = "Invalid screenshot asset URL" })
        end
        local host = url:match("^https://([%w%.%-]+)/")
        host = host and host:lower() or ""
        if not (host:match("%.steamstatic%.com$") or host:match("%.steamusercontent%.com$")
            or host == "steamuserimages-a.akamaihd.net" or host == "steamcdn-a.akamaihd.net") then
            return json.encode({ success = false, error = "Screenshot asset host is not supported" })
        end
        local response, request_error = http.get(url, { timeout = 8, follow_redirects = false, verify_ssl = true })
        if not response or response.status ~= 200 then
            return json.encode({ success = false, error = request_error or ("Image HTTP " .. tostring(response and response.status)) })
        end
        local body = response.body
        if type(body) ~= "string" or #body < 12 or #body > 8388608 then
            return json.encode({ success = false, error = "Screenshot asset is empty or exceeds 8 MiB" })
        end
        local mime = nil
        if body:sub(1, 8) == string.char(137) .. "PNG\r\n" .. string.char(26) .. "\n" then mime = "image/png"
        elseif body:sub(1, 3) == string.char(255, 216, 255) then mime = "image/jpeg"
        elseif body:sub(1, 6) == "GIF87a" or body:sub(1, 6) == "GIF89a" then mime = "image/gif"
        elseif body:sub(1, 4) == "RIFF" and body:sub(9, 12) == "WEBP" then mime = "image/webp" end
        if not mime then return json.encode({ success = false, error = "Unsupported screenshot asset format" }) end
        return json.encode({ success = true, mime = mime, base64 = utils.base64_encode(body) })
    end)
    if not success then
        logger:error("Screenshot asset retrieval failed: " .. tostring(result))
        return json.encode({ success = false, error = tostring(result) })
    end
    return result
end

function ListPresets(steam_id)
    local success, result = pcall(function()
        migrate_legacy_presets()

        local sid   = sanitize_steam_id(steam_id)
        local index = load_index(sid)
        local presets = {}

        for _, safe_name in ipairs(index) do
            local content = read_file(preset_path(sid, safe_name))
            if content then
                local ok, data = pcall(json.decode, content)
                if ok and data then
                    local screenshot = nil
                    if data.hasScreenshot then
                        screenshot = read_file(screenshot_path(sid, safe_name))
                    end
                    table.insert(presets, {
                        name            = data.name,
                        savedAt         = data.savedAt,
                        steamId         = data.steamId,
                        personaName     = data.personaName,
                        avatarHash      = data.avatarHash,
                        theme           = data.theme,
                        hasLocalAvatar  = data.hasLocalAvatar or false,
                        avatarType      = data.avatarType or "uploaded",
                        hasScreenshot   = data.hasScreenshot or false,
                        screenshotBase64 = screenshot,
                        screenshotMime  = data.screenshotMime or "image/jpeg",
                    })
                end
            end
        end

        return json.encode(presets)
    end)

    if not success then
        logger:error("ListPresets error: " .. tostring(result))
        return json.encode({})
    end
    return result
end

local function validate_screenshot(content)
    if type(content) ~= "string" or #content < 100 or #content > 4194304 or #content % 4 ~= 0
        or content:find("[^A-Za-z0-9+/=]") or not content:match("^/9j/") then
        return false, "Invalid JPEG screenshot data"
    end
    local alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    local bytes = {}
    for offset = 1, #content, 4 do
        local value, padding = 0, 0
        for index = offset, offset + 3 do
            local character = content:sub(index, index)
            if character == "=" then
                padding = padding + 1
                if offset + 3 ~= #content or index < offset + 2 then return false, "Invalid base64 padding" end
                value = value * 64
            else
                if padding > 0 then return false, "Invalid base64 padding" end
                local position = alphabet:find(character, 1, true)
                if not position then return false, "Invalid base64 data" end
                value = value * 64 + position - 1
            end
        end
        bytes[#bytes + 1] = string.char(math.floor(value / 65536) % 256)
        if padding < 2 then bytes[#bytes + 1] = string.char(math.floor(value / 256) % 256) end
        if padding < 1 then bytes[#bytes + 1] = string.char(value % 256) end
    end
    local decoded = table.concat(bytes)
    if decoded:sub(1, 2) ~= string.char(255, 216) or decoded:sub(-2) ~= string.char(255, 217) then
        return false, "Incomplete JPEG screenshot"
    end
    return true
end

local function write_screenshot(path, content)
    if read_file(path) == content then return true end
    local temporary = path .. ".tmp"
    local previous = path .. ".previous"
    if file_exists(previous) then return false, "Screenshot recovery file exists; original image preserved" end
    local ok, err = write_file(temporary, content)
    if not ok or read_file(temporary) ~= content then
        os.remove(temporary)
        return false, err or "Screenshot verification failed"
    end
    local had_previous = file_exists(path)
    if had_previous then
        local moved, move_error = os.rename(path, previous)
        if not moved then
            os.remove(temporary)
            return false, move_error or "Cannot preserve previous screenshot"
        end
    end
    local committed, commit_error = os.rename(temporary, path)
    if not committed then
        if had_previous then os.rename(previous, path) end
        os.remove(temporary)
        return false, commit_error or "Cannot commit screenshot"
    end
    if had_previous then os.remove(previous) end
    return true
end

function SavePreset(preset_json, steam_id)
    local success, result = pcall(function()
        migrate_legacy_presets()

        local sid = sanitize_steam_id(steam_id)

        local ok, data = pcall(json.decode, preset_json)
        if not ok or type(data) ~= "table" then
            return json.encode({ success = false, error = "Invalid JSON" })
        end

        local name = data.name or ""
        if name == "" then
            return json.encode({ success = false, error = "Preset name is empty" })
        end

        local safe_name = sanitize(name)
        if safe_name == "" then
            return json.encode({ success = false, error = "Preset name has no valid characters" })
        end

        data.steamId = steam_id

        if data.avatarBase64 and data.avatarBase64 ~= "" then
            local av_ok, av_err = write_file(avatar_path(sid, safe_name), data.avatarBase64)
            if not av_ok then
                logger:error("Avatar write failed: " .. (av_err or ""))
            end
            data.hasLocalAvatar = true
            data.avatarBase64 = nil
        end

        local screenshot_error = type(data.screenshotError) == "string" and data.screenshotError or nil
        data.screenshotError = nil
        local previous_content = read_file(preset_path(sid, safe_name))
        local previous = nil
        if previous_content then
            local previous_ok, decoded = pcall(json.decode, previous_content)
            if previous_ok and type(decoded) == "table" then previous = decoded end
        end
        data.hasScreenshot = previous and previous.hasScreenshot and file_exists(screenshot_path(sid, safe_name)) or false
        data.screenshotMime = previous and previous.screenshotMime or "image/jpeg"
        if data.screenshotBase64 and data.screenshotBase64 ~= "" then
            local screenshot = data.screenshotBase64
            local valid, validation_error = validate_screenshot(screenshot)
            if valid then
                local sc_ok, sc_err = write_screenshot(screenshot_path(sid, safe_name), screenshot)
                if sc_ok then
                    data.hasScreenshot = true
                    data.screenshotMime = "image/jpeg"
                else
                    screenshot_error = sc_err
                end
            else
                screenshot_error = validation_error
            end
        end
        data.screenshotBase64 = nil
        if screenshot_error then logger:error("Screenshot failed: " .. screenshot_error) end

        local write_ok, write_err = write_file(preset_path(sid, safe_name), json.encode(data))
        if not write_ok then
            return json.encode({ success = false, error = write_err or "Write failed" })
        end

        index_add(sid, safe_name)

        logger:info("Preset saved: " .. name .. " -> " .. sid .. "/" .. safe_name)
        return json.encode({ success = true, name = name, screenshotError = screenshot_error })
    end)

    if not success then
        logger:error("SavePreset error: " .. tostring(result))
        return json.encode({ success = false, error = tostring(result) })
    end
    return result
end

function LoadPreset(name, steam_id)
    local success, result = pcall(function()
        migrate_legacy_presets()

        local sid       = sanitize_steam_id(steam_id)
        local safe_name = sanitize(name)
        local content    = read_file(preset_path(sid, safe_name))
        if not content then
            return json.encode({ success = false, error = "Preset not found: " .. name })
        end

        local ok, data = pcall(json.decode, content)
        if not ok or type(data) ~= "table" then
            return json.encode({ success = false, error = "Corrupt preset file" })
        end

        local stored_steam_id = tostring(data.steamId or "")
        if stored_steam_id ~= "" and stored_steam_id ~= tostring(steam_id) then
            logger:error("LoadPreset refused: preset '" .. name .. "' belongs to steamId " ..
                stored_steam_id .. ", requested by " .. tostring(steam_id))
            return json.encode({ success = false, error = "This preset belongs to a different Steam account" })
        end

        if data.hasLocalAvatar then
            local av = read_file(avatar_path(sid, safe_name))
            if av then
                data.avatarBase64 = av
            end
        end

        return json.encode({ success = true, preset = data })
    end)

    if not success then
        logger:error("LoadPreset error: " .. tostring(result))
        return json.encode({ success = false, error = tostring(result) })
    end
    return result
end

function DeletePreset(name, steam_id)
    local success, result = pcall(function()
        migrate_legacy_presets()

        local sid       = sanitize_steam_id(steam_id)
        local safe_name  = sanitize(name)

        if not file_exists(preset_path(sid, safe_name)) then
            return json.encode({ success = false, error = "Preset not found" })
        end

        delete_file(preset_path(sid, safe_name))
        delete_file(avatar_path(sid, safe_name))
        delete_file(screenshot_path(sid, safe_name))
        remove_dir(preset_dir(sid, safe_name))

        local index     = load_index(sid)
        local new_index = {}
        for _, n in ipairs(index) do
            if n ~= safe_name then
                table.insert(new_index, n)
            end
        end
        save_index(sid, new_index)

        logger:info("Preset deleted: " .. sid .. "/" .. name)
        return json.encode({ success = true })
    end)

    if not success then
        logger:error("DeletePreset error: " .. tostring(result))
        return json.encode({ success = false, error = tostring(result) })
    end
    return result
end

function LogApplySummary(summary_json, steam_id)
    local success, result = pcall(function()
        local ok, data = pcall(json.decode, summary_json)
        if not ok or type(data) ~= "table" then
            return json.encode({ success = false, error = "Invalid JSON" })
        end

        logger:info("Apply started: " .. tostring(data.presetName or "unknown"))

        local entries = data.entries or {}
        for _, entry in ipairs(entries) do
            local step_name = entry.step or "Unknown step"
            if entry.success then
                logger:info(step_name .. " - success")
            else
                logger:error(step_name .. " - failed: " .. tostring(entry.error or "unknown error"))
            end
        end

        local overall = data.overall or "UNKNOWN"
        local summary_line = string.format(
            "Apply finished: %s (%d ok, %d failed, %dms)",
            tostring(overall),
            tonumber(data.successful) or 0,
            tonumber(data.failed) or 0,
            tonumber(data.durationMs) or 0
        )
        if overall == "FAILED" then
            logger:error(summary_line)
        else
            logger:info(summary_line)
        end

        return json.encode({ success = true })
    end)

    if not success then
        logger:error("LogApplySummary error: " .. tostring(result))
        return json.encode({ success = false, error = tostring(result) })
    end
    return result
end

local function on_load()
    logger:info("Profile Presets backend loaded")
    logger:info("Presets directory: " .. get_presets_dir())
    migrate_legacy_presets()
    millennium.ready()
end

local function on_unload()
    logger:info("Profile Presets backend unloaded")
end

return {
    on_load           = on_load,
    on_unload         = on_unload,
    ListPresets       = ListPresets,
    SavePreset        = SavePreset,
    LoadPreset        = LoadPreset,
    DeletePreset      = DeletePreset,
    LogApplySummary   = LogApplySummary,
    FetchScreenshotAsset = FetchScreenshotAsset,
}
