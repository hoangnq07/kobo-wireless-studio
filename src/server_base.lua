-- Kobo Wi-Fi Web File Manager (LuaJIT + LuaSocket + LFS)
-- Compatible with Kobo Linux 2.6.31 / 3.0.35+ (Zero RAM buffering for 100MB-500MB+ uploads)

io.stdout:setvbuf("line")
io.stderr:setvbuf("line")

local KOREADER_DIR = "/mnt/onboard/.adds/koreader"
package.path = KOREADER_DIR .. "/?.lua;" .. KOREADER_DIR .. "/common/?.lua;" .. KOREADER_DIR .. "/frontend/?.lua;" .. package.path
package.cpath = KOREADER_DIR .. "/?.so;" .. KOREADER_DIR .. "/common/?.so;" .. package.cpath

pcall(require, "setupkoenv")

local socket = require("socket")
local ok_lfs, lfs = pcall(require, "libs/libkoreader-lfs")
if not ok_lfs or not lfs then
    local loader = assert(package.loadlib(KOREADER_DIR .. "/libs/libkoreader-lfs.so", "luaopen_lfs"))
    lfs = loader()
end

pcall(function()
    local ffi = require("ffi")
    ffi.cdef[[ int getpid(void); ]]
    local pf = io.open("/tmp/kobo_webfiles.pid", "wb")
    if pf then
        pf:write(tostring(ffi.C.getpid()), "\n")
        pf:close()
    end
end)

local ROOT = "/mnt/onboard"
local PORT = 8080

-- Ensure /mnt/onboard/Books exists
if lfs.attributes(ROOT .. "/Books", "mode") ~= "directory" then
    lfs.mkdir(ROOT .. "/Books")
end

-- Move cwd to /tmp so /mnt/onboard is never held busy when plugging USB
pcall(lfs.chdir, "/tmp")

local function url_decode(s)
    if not s then return "" end
    s = s:gsub("%+", " ")
    return (s:gsub("%%(%x%x)", function(h)
        return string.char(tonumber(h, 16))
    end))
end

local function parse_query(qs)
    local out = {}
    if not qs or qs == "" then return out end
    for pair in qs:gmatch("[^&]+") do
        local k, v = pair:match("^([^=]+)=(.*)$")
        if k then
            out[url_decode(k)] = url_decode(v)
        else
            out[url_decode(pair)] = ""
        end
    end
    return out
end

local function sanitize_rel_path(rel)
    if not rel or rel == "" then return "" end
    rel = rel:gsub("\\", "/")
    local parts = {}
    for seg in rel:gmatch("[^/]+") do
        if seg ~= "." and seg ~= ".." then
            table.insert(parts, seg)
        end
    end
    return table.concat(parts, "/")
end

local function sanitize_filename(name)
    if not name then return "" end
    name = name:gsub("^.*[/\\]", "")
    -- Replace FAT32 illegal characters and control chars
    name = name:gsub('[%c:*?"<>|\\]', "_")
    name = name:gsub("[%. ]+$", "")
    if name == "" or name == "." or name == ".." then
        return ""
    end
    return name
end

local function full_path(rel)
    local clean = sanitize_rel_path(rel)
    if clean == "" then return ROOT, "" end
    return ROOT .. "/" .. clean, "/" .. clean
end

local function json_escape(s)
    return (tostring(s)
        :gsub("\\", "\\\\")
        :gsub('"', '\\"')
        :gsub("\b", "\\b")
        :gsub("\f", "\\f")
        :gsub("\n", "\\n")
        :gsub("\r", "\\r")
        :gsub("\t", "\\t"))
end

local function json_encode(v)
    local t = type(v)
    if v == nil then
        return "null"
    elseif t == "boolean" then
        return v and "true" or "false"
    elseif t == "number" then
        if v ~= v or v == math.huge or v == -math.huge then return "0" end
        return tostring(v)
    elseif t == "string" then
        return '"' .. json_escape(v) .. '"'
    elseif t == "table" then
        local is_arr = true
        local max_i = 0
        local count = 0
        for k, _ in pairs(v) do
            count = count + 1
            if type(k) ~= "number" or k < 1 or math.floor(k) ~= k then
                is_arr = false
                break
            end
            if k > max_i then max_i = k end
        end
        if is_arr and max_i == count then
            local items = {}
            for i = 1, max_i do
                items[i] = json_encode(v[i])
            end
            return "[" .. table.concat(items, ",") .. "]"
        else
            local items = {}
            for k, val in pairs(v) do
                table.insert(items, '"' .. json_escape(k) .. '":' .. json_encode(val))
            end
            return "{" .. table.concat(items, ",") .. "}"
        end
    end
    return "null"
end

local function get_disk_space()
    local p = io.popen("df -k /mnt/onboard 2>/dev/null", "r")
    if not p then return nil end
    local out = p:read("*a") or ""
    p:close()
    -- Match last line with numbers: total used avail
    local total_kb, used_kb, avail_kb
    for t, u, a in out:gmatch("(%d+)%s+(%d+)%s+(%d+)%s+%d+%%") do
        total_kb, used_kb, avail_kb = tonumber(t), tonumber(u), tonumber(a)
    end
    if total_kb and avail_kb then
        return {
            total_bytes = total_kb * 1024,
            used_bytes = (used_kb or 0) * 1024,
            free_bytes = avail_kb * 1024,
        }
    end
    return nil
end

local function send_all(client, data)
    local total = #data
    local idx = 1
    local timeouts = 0
    while idx <= total do
        local sent, err, last = client:send(data, idx, total)
        if sent then
            idx = sent + 1
            timeouts = 0
        elseif err == "timeout" then
            if last and last >= idx then
                idx = last + 1
                timeouts = 0
            else
                timeouts = timeouts + 1
                if timeouts > 6 then return false, "send timeout" end
            end
        else
            return false, err or "send closed"
        end
    end
    return true
end

local STATUS_TEXT = {
    [200] = "OK",
    [400] = "Bad Request",
    [404] = "Not Found",
    [405] = "Method Not Allowed",
    [408] = "Request Timeout",
    [500] = "Internal Server Error",
}

local function send_response(client, code, ctype, body, extra_headers)
    body = body or ""
    local hdr = string.format(
        "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nCache-Control: no-store\r\nConnection: close\r\n%s\r\n",
        code, STATUS_TEXT[code] or "OK", ctype, #body, extra_headers or ""
    )
    send_all(client, hdr)
    if #body > 0 then
        send_all(client, body)
    end
end

local function send_json(client, code, tbl)
    send_response(client, code, "application/json; charset=utf-8", json_encode(tbl))
end

local function drain_body(client, content_len)
    local rem = content_len or 0
    while rem > 0 and rem <= 65536 do
        local chunk = client:receive(rem)
        if not chunk or #chunk == 0 then break end
        rem = rem - #chunk
    end
end

local INDEX_HTML = [====[__STUDIO_INDEX_HTML__]====]

local function handle_list(client, query)
    local fs_dir, disp_dir = full_path(query.dir or "/Books")
    if disp_dir == "" then disp_dir = "/" end
    local show_hidden = (query.hidden == "1") or (disp_dir:find("^/%.adds") ~= nil) or (disp_dir:find("^/%.kobo") ~= nil)
    if lfs.attributes(fs_dir, "mode") ~= "directory" then
        fs_dir, disp_dir = ROOT, "/"
    end

    local items = {}
    for entry in lfs.dir(fs_dir) do
        if entry ~= "." and entry ~= ".." and not entry:find("%.uploading$") then
            local hidden = (entry:sub(1, 1) == ".")
            if show_hidden or not hidden then
                local p = fs_dir .. "/" .. entry
                local attr = lfs.attributes(p)
                if attr then
                    table.insert(items, {
                        name = entry,
                        is_dir = (attr.mode == "directory"),
                        size = (attr.mode == "directory") and 0 or (attr.size or 0),
                        mtime = attr.modification or 0,
                    })
                end
            end
        end
    end

    table.sort(items, function(a, b)
        if a.is_dir ~= b.is_dir then return a.is_dir end
        return a.name:lower() < b.name:lower()
    end)

    send_json(client, 200, {
        ok = true,
        dir = disp_dir,
        disk = get_disk_space(),
        items = items,
    })
end

local function handle_upload(client, query, headers)
    local fs_dir = full_path(query.dir or "/Books")
    if lfs.attributes(fs_dir, "mode") ~= "directory" then
        return send_json(client, 400, { ok = false, error = "Thư mục đích không tồn tại" })
    end
    local safe_name = sanitize_filename(query.name)
    if safe_name == "" then
        return send_json(client, 400, { ok = false, error = "Tên file không hợp lệ" })
    end

    if headers["expect"] and headers["expect"]:lower():find("100%-continue") then
        send_all(client, "HTTP/1.1 100 Continue\r\n\r\n")
    end

    local content_len = tonumber(headers["content-length"] or "0") or 0
    local target_path = fs_dir .. "/" .. safe_name
    local part_path = target_path .. ".uploading"

    local f, ferr = io.open(part_path, "wb")
    if not f then
        return send_json(client, 500, { ok = false, error = "Không thể mở file để ghi: " .. tostring(ferr) })
    end

    client:settimeout(30)
    local remaining = content_len
    local timeouts = 0
    while remaining > 0 do
        local ask = (remaining < 65536) and remaining or 65536
        local chunk, rerr, partial = client:receive(ask)
        if chunk and #chunk > 0 then
            local wok, werr = f:write(chunk)
            if not wok then
                f:close()
                os.remove(part_path)
                return send_json(client, 500, { ok = false, error = "Lỗi ghi bộ nhớ (có thể đầy dung lượng): " .. tostring(werr) })
            end
            remaining = remaining - #chunk
            timeouts = 0
        else
            if partial and #partial > 0 then
                local wok, werr = f:write(partial)
                if not wok then
                    f:close()
                    os.remove(part_path)
                    return send_json(client, 500, { ok = false, error = "Lỗi ghi bộ nhớ: " .. tostring(werr) })
                end
                remaining = remaining - #partial
                timeouts = 0
            end
            if rerr == "timeout" then
                timeouts = timeouts + 1
                if timeouts > 6 then
                    f:close()
                    os.remove(part_path)
                    return send_json(client, 408, { ok = false, error = "Mạng Wi-Fi phản hồi quá chậm (timeout)" })
                end
            else
                f:close()
                os.remove(part_path)
                return
            end
        end
    end

    f:flush()
    f:close()
    os.remove(target_path)
    local rok, rerr = os.rename(part_path, target_path)
    if not rok then
        os.remove(part_path)
        return send_json(client, 500, { ok = false, error = "Lỗi đổi tên file hoàn tất: " .. tostring(rerr) })
    end

    local kobo_ss = ROOT .. "/.kobo/screensaver"
    local ko_ss = ROOT .. "/.adds/koreader/screensavers"
    local mirror_dst = nil
    if fs_dir == kobo_ss then mirror_dst = ko_ss .. "/" .. safe_name
    elseif fs_dir == ko_ss then mirror_dst = kobo_ss .. "/" .. safe_name end
    if mirror_dst then
        pcall(function()
            lfs.mkdir(kobo_ss)
            lfs.mkdir(ko_ss)
            local rf = io.open(target_path, "rb")
            if rf then
                local wf2 = io.open(mirror_dst, "wb")
                if wf2 then
                    while true do
                        local c = rf:read(65536)
                        if not c or #c == 0 then break end
                        wf2:write(c)
                    end
                    wf2:close()
                end
                rf:close()
            end
        end)
    end

    send_json(client, 200, { ok = true, name = safe_name, size = content_len })
end

local function url_encode_rfc5987(s)
    return (s:gsub("[^%w%-_%.~]", function(c)
        return string.format("%%%02X", string.byte(c))
    end))
end

local function handle_download(client, query)
    local fs_path = full_path(query.path or "")
    local attr = lfs.attributes(fs_path)
    if not attr or attr.mode ~= "file" then
        return send_response(client, 404, "text/plain; charset=utf-8", "Không tìm thấy file")
    end
    local f = io.open(fs_path, "rb")
    if not f then
        return send_response(client, 500, "text/plain; charset=utf-8", "Không thể đọc file")
    end

    local fname = fs_path:match("([^/]+)$") or "download.bin"
    local ascii_name = fname:gsub('[^\32-\126]', "_"):gsub('"', "_")
    local disp = string.format('Content-Disposition: attachment; filename="%s"; filename*=UTF-8\'\'%s\r\n',
        ascii_name, url_encode_rfc5987(fname))
    local hdr = string.format(
        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: %d\r\nConnection: close\r\n%s\r\n",
        attr.size or 0, disp
    )
    client:settimeout(30)
    if not send_all(client, hdr) then
        f:close()
        return
    end
    while true do
        local chunk = f:read(65536)
        if not chunk or #chunk == 0 then break end
        if not send_all(client, chunk) then break end
    end
    f:close()
end

local function handle_mkdir(client, query)
    local fs_dir = full_path(query.dir or "/Books")
    local safe_name = sanitize_filename(query.name)
    if safe_name == "" then
        return send_json(client, 400, { ok = false, error = "Tên thư mục không hợp lệ" })
    end
    local ok, err = lfs.mkdir(fs_dir .. "/" .. safe_name)
    if not ok then
        return send_json(client, 500, { ok = false, error = "Không thể tạo thư mục: " .. tostring(err) })
    end
    send_json(client, 200, { ok = true, name = safe_name })
end

local function handle_delete(client, query)
    local rel = sanitize_rel_path(query.path or "")
    local is_kobo_ss_file = (rel:match("^%.kobo/screensaver/[^/]+$") ~= nil)
    if rel == "" or rel == ".kobo" or rel == ".adds" or (rel:find("^%.kobo/") and not is_kobo_ss_file) then
        return send_json(client, 400, { ok = false, error = "Không cho phép xóa thư mục hệ thống Kobo!" })
    end
    local fs_path = ROOT .. "/" .. rel
    local mode = lfs.attributes(fs_path, "mode")
    if not mode then
        return send_json(client, 404, { ok = false, error = "File không tồn tại" })
    end
    local ok, err
    if mode == "directory" then
        ok, err = lfs.rmdir(fs_path)
    else
        ok, err = os.remove(fs_path)
        if ok then
            local ss_name = rel:match("^%.kobo/screensaver/([^/]+)$") or rel:match("^%.adds/koreader/screensavers/([^/]+)$")
            if ss_name then
                os.remove(ROOT .. "/.kobo/screensaver/" .. ss_name)
                os.remove(ROOT .. "/.adds/koreader/screensavers/" .. ss_name)
            end
        end
    end
    if not ok then
        return send_json(client, 500, { ok = false, error = tostring(err) })
    end
    send_json(client, 200, { ok = true })
end

local function handle_vendor(client, path_part)
    local vname = sanitize_filename(path_part:match("^/vendor/(.+)$") or "")
    if vname == "" or not vname:find("%.js$") then
        return send_response(client, 404, "text/plain; charset=utf-8", "Not Found")
    end
    local vpath = ROOT .. "/.adds/tools/vendor/" .. vname
    local attr = lfs.attributes(vpath)
    if not attr or attr.mode ~= "file" then
        return send_response(client, 404, "text/plain; charset=utf-8", "Vendor JS Not Found")
    end
    local f = io.open(vpath, "rb")
    if not f then
        return send_response(client, 500, "text/plain; charset=utf-8", "Read Error")
    end
    local hdr = string.format(
        "HTTP/1.1 200 OK\r\nContent-Type: application/javascript; charset=utf-8\r\nContent-Length: %d\r\nCache-Control: public, max-age=86400\r\nConnection: close\r\n\r\n",
        attr.size or 0
    )
    client:settimeout(30)
    if send_all(client, hdr) then
        while true do
            local chunk = f:read(65536)
            if not chunk or #chunk == 0 then break end
            if not send_all(client, chunk) then break end
        end
    end
    f:close()
end

local function handle_client(client)
    client:settimeout(2)
    local req_line = client:receive("*l")
    if not req_line or req_line == "" then return end
    client:settimeout(15)

    local method, raw_target = req_line:match("^(%S+)%s+(%S+)")
    if not method or not raw_target then return end

    local headers = {}
    while true do
        local hline = client:receive("*l")
        if not hline or hline == "" then break end
        local hk, hv = hline:match("^([^:]+):%s*(.*)$")
        if hk then
            headers[hk:lower()] = hv
        end
    end

    local path_part, qs_part = raw_target:match("^([^?]+)%??(.*)$")
    local query = parse_query(qs_part)
    local content_len = tonumber(headers["content-length"] or "0") or 0
    io.write("[webfiles] ", tostring(method), " ", tostring(path_part), "\n")

    if method == "GET" and (path_part == "/" or path_part == "/index.html") then
        send_response(client, 200, "text/html; charset=utf-8", INDEX_HTML)
    elseif method == "GET" and path_part:find("^/vendor/") then
        handle_vendor(client, path_part)
    elseif method == "GET" and path_part == "/api/list" then
        handle_list(client, query)
    elseif method == "POST" and path_part == "/api/upload" then
        handle_upload(client, query, headers)
    elseif method == "GET" and path_part == "/api/download" then
        handle_download(client, query)
    elseif method == "POST" and path_part == "/api/mkdir" then
        drain_body(client, content_len)
        handle_mkdir(client, query)
    elseif method == "POST" and path_part == "/api/delete" then
        drain_body(client, content_len)
        handle_delete(client, query)
    elseif method == "POST" and path_part == "/api/reload" then
        drain_body(client, content_len)
        local rf = io.open(ROOT .. "/.adds/tools/webfiles.lua", "rb")
        local src = rf and rf:read("*a")
        if rf then rf:close() end
        local m1 = "local INDEX_HTML = [" .. "====["
        local m2 = "]" .. "====]"
        local p1 = src and src:find(m1, 1, true)
        local p2 = p1 and src:find(m2, p1 + #m1, true)
        if p1 and p2 and (p2 - (p1 + #m1)) > 1000 then
            INDEX_HTML = src:sub(p1 + #m1, p2 - 1)
            send_json(client, 200, { ok = true, html_bytes = #INDEX_HTML })
        else
            send_json(client, 500, { ok = false, error = "Could not reload INDEX_HTML" })
        end
    else
        drain_body(client, content_len)
        send_response(client, 404, "text/plain; charset=utf-8", "404 Not Found")
    end
end

local server, berr
if socket.tcp4 then
    server, berr = socket.tcp4()
else
    server, berr = socket.tcp()
end
assert(server, "Cannot create TCP socket: " .. tostring(berr))
server:setoption("reuseaddr", true)
assert(server:bind("0.0.0.0", PORT), "Cannot bind port " .. tostring(PORT))
assert(server:listen(16), "Cannot listen on port " .. tostring(PORT))
server:settimeout(5)

io.write("[webfiles] Listening on 0.0.0.0:", tostring(PORT), "\n")

while true do
    local client = server:accept()
    if client then
        local ok, cerr = pcall(handle_client, client)
        if not ok then
            io.stderr:write("[webfiles] client error: ", tostring(cerr), "\n")
        end
        pcall(function() client:close() end)
    end
end
