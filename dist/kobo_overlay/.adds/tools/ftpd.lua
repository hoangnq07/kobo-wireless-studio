-- Kobo Wireless Studio — Pure LuaJIT RFC-959 / RFC-2428 / RFC-3659 FTP Server (:1021)
-- Compatible with Kobo Linux 2.6.31 / 3.0.35+ (KOReader LuaJIT + LuaSocket + LFS)
-- Supports: Windows File Explorer (msieftp.dll), FileZilla, WinSCP, Solid Explorer, curl, ftplib
-- Zero password friction: Accepts both anonymous login and root:kobo

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
    local pf = io.open("/tmp/kobo_ftpd.pid", "wb")
    if pf then
        pf:write(tostring(ffi.C.getpid()), "\n")
        pf:close()
    end
end)

local ROOT = "/mnt/onboard"
local PORT = 1021

if lfs.attributes(ROOT .. "/Books", "mode") ~= "directory" then
    pcall(lfs.mkdir, ROOT .. "/Books")
end

-- Move cwd to /tmp immediately so /mnt/onboard is never held busy when plugging in USB
pcall(lfs.chdir, "/tmp")

local MONTHS = { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" }

local function send_all(sock, data)
    if not sock or not data or #data == 0 then return true end
    local total = #data
    local idx = 1
    local timeouts = 0
    while idx <= total do
        local sent, err, last = sock:send(data, idx, total)
        if sent then
            idx = sent + 1
            timeouts = 0
        elseif err == "timeout" then
            if last and last >= idx then
                idx = last + 1
                timeouts = 0
            else
                timeouts = timeouts + 1
                if timeouts > 6 then return nil, "send timeout" end
            end
        else
            return nil, err or "send closed"
        end
    end
    return true
end

local function reply(client, code, msg)
    if not client or not client.sock or client.closed then return end
    local line = string.format("%d %s\r\n", code, msg or "")
    local ok, err = send_all(client.sock, line)
    if not ok and err == "closed" then
        client.closed = true
    end
end

local function close_data(client)
    if not client then return end
    if client.data_sock then
        pcall(function() client.data_sock:close() end)
        client.data_sock = nil
    end
    if client.pasv_srv then
        pcall(function() client.pasv_srv:close() end)
        client.pasv_srv = nil
    end
    client.port_ip = nil
    client.port_port = nil
end

local function close_client(client)
    if not client then return end
    close_data(client)
    if client.sock then
        pcall(function() client.sock:close() end)
        client.sock = nil
    end
    client.closed = true
end

local function detect_local_ip(control_sock)
    if control_sock then
        local ok, ip = pcall(function() return (control_sock:getsockname()) end)
        if ok and ip then
            ip = tostring(ip):gsub("^::ffff:", "")
            if ip:match("^%d+%.%d+%.%d+%.%d+$") and ip ~= "0.0.0.0" and ip ~= "127.0.0.1" then
                return ip
            end
        end
    end
    local u = socket.udp()
    if u then
        pcall(function() u:setpeername("192.168.1.1", 80) end)
        local ok, uip = pcall(function() return (u:getsockname()) end)
        pcall(function() u:close() end)
        if ok and uip then
            uip = tostring(uip):gsub("^::ffff:", "")
            if uip:match("^%d+%.%d+%.%d+%.%d+$") and uip ~= "0.0.0.0" and uip ~= "127.0.0.1" then
                return uip
            end
        end
    end
    return "127.0.0.1"
end

local function resolve_ftp_path(cwd, arg)
    local raw = ""
    if not arg or arg == "" then
        raw = cwd or "/"
    elseif arg:sub(1, 1) == "/" or arg:sub(1, 1) == "\\" then
        raw = arg
    else
        raw = (cwd or "/") .. "/" .. arg
    end
    raw = raw:gsub("\\", "/")
    local parts = {}
    for seg in raw:gmatch("[^/]+") do
        if seg == ".." then
            if #parts > 0 then
                table.remove(parts)
            end
        elseif seg ~= "." and seg ~= "" then
            table.insert(parts, seg)
        end
    end
    local vpath = "/" .. table.concat(parts, "/")
    local rpath = (#parts == 0) and ROOT or (ROOT .. "/" .. table.concat(parts, "/"))
    return vpath, rpath, parts
end

local function ensure_parent_dirs(rpath)
    local parent = rpath:match("^(.*)/[^/]+$")
    if not parent or parent == "" or parent == ROOT then return true end
    local rel = parent:sub(#ROOT + 2)
    local cur = ROOT
    for seg in rel:gmatch("[^/]+") do
        cur = cur .. "/" .. seg
        if lfs.attributes(cur, "mode") ~= "directory" then
            pcall(lfs.mkdir, cur)
        end
    end
    return true
end

local function copy_file_binary(src, dst)
    local fi = io.open(src, "rb")
    if not fi then return false end
    ensure_parent_dirs(dst)
    local fo = io.open(dst, "wb")
    if not fo then
        fi:close()
        return false
    end
    while true do
        local chunk = fi:read(65536)
        if not chunk or #chunk == 0 then break end
        fo:write(chunk)
    end
    fi:close()
    fo:close()
    return true
end

local function sync_screensaver_mirror(vpath, rpath, is_delete)
    local fname = rpath:match("([^/]+)$")
    if not fname or fname == "" then return end
    local kobo_ss = ROOT .. "/.kobo/screensaver/" .. fname
    local ko_ss   = ROOT .. "/.adds/koreader/screensavers/" .. fname

    if vpath:sub(1, 18) == "/.kobo/screensaver" then
        if is_delete then
            os.remove(ko_ss)
        else
            copy_file_binary(rpath, ko_ss)
        end
    elseif vpath:sub(1, 28) == "/.adds/koreader/screensavers" then
        if is_delete then
            os.remove(kobo_ss)
        else
            copy_file_binary(rpath, kobo_ss)
        end
    end
end

local function strip_list_flags(arg)
    if not arg then return "" end
    arg = arg:match("^%s*(.-)%s*$") or ""
    while arg:sub(1, 1) == "-" do
        local rest = arg:match("^%-[a1lAdFRrtS]+%s*(.*)$")
        if rest ~= nil then
            arg = rest
        else
            break
        end
    end
    return arg
end

local function is_ignored_entry(name)
    if not name or name == "." or name == ".." then return true end
    if name == "$RECYCLE.BIN" or name == "System Volume Information" then return true end
    if name:match("^fsck%d+%.rec$") then return true end
    return false
end

local function format_ls_line(name, attr)
    local is_dir = (attr and attr.mode == "directory")
    local perms = is_dir and "drwxr-xr-x" or "-rw-r--r--"
    local nlink = is_dir and 2 or 1
    local sz = is_dir and 0 or ((attr and attr.size) or 0)
    local mtime = (attr and attr.modification) or os.time()
    local t = os.date("*t", mtime)
    local m = (t and MONTHS[t.month]) or "Jan"
    local d = (t and t.day) or 1
    local hh = (t and t.hour) or 0
    local mm = (t and t.min) or 0
    return string.format("%s %3d root root %12d %s %02d %02d:%02d %s\r\n", perms, nlink, sz, m, d, hh, mm, name)
end

local function format_mlsd_line(name, attr)
    local is_dir = (attr and attr.mode == "directory")
    local sz = is_dir and 0 or ((attr and attr.size) or 0)
    local mtime = (attr and attr.modification) or os.time()
    local ts = os.date("!%Y%m%d%H%M%S", mtime) or "20260101000000"
    if is_dir then
        return string.format("type=dir;modify=%s;perm=flcdmpe; %s\r\n", ts, name)
    else
        return string.format("type=file;size=%d;modify=%s;perm=adfrw; %s\r\n", sz, ts, name)
    end
end

local function open_data_sock(client)
    if client.data_sock then
        local ds = client.data_sock
        client.data_sock = nil
        ds:settimeout(30)
        return ds
    end
    if client.pasv_srv then
        local srv = client.pasv_srv
        client.pasv_srv = nil
        srv:settimeout(15)
        local ds, err = srv:accept()
        pcall(function() srv:close() end)
        if not ds then return nil, err or "PASV accept timeout" end
        ds:settimeout(30)
        pcall(function() ds:setoption("tcp-nodelay", true) end)
        return ds
    elseif client.port_ip and client.port_port then
        local ip, port = client.port_ip, client.port_port
        client.port_ip, client.port_port = nil, nil
        local ds = socket.tcp()
        ds:settimeout(10)
        local ok, err = ds:connect(ip, port)
        if not ok then
            pcall(function() ds:close() end)
            return nil, err or "PORT connect failed"
        end
        ds:settimeout(30)
        pcall(function() ds:setoption("tcp-nodelay", true) end)
        return ds
    end
    return nil, "No data connection established (send PASV, EPSV, or PORT first)"
end

local function collect_dir_entries(vpath, rpath)
    local attr = lfs.attributes(rpath)
    if not attr then return nil, nil end
    if attr.mode ~= "directory" then
        local single_name = rpath:match("([^/]+)$") or "file"
        return { { name = single_name, attr = attr } }, "file"
    end
    local list = {}
    local ok_iter, iter, dir_obj = pcall(lfs.dir, rpath)
    if not ok_iter or not iter then return nil, nil end
    for entry in iter, dir_obj do
        if not is_ignored_entry(entry) then
            local full = rpath .. "/" .. entry
            local ea = lfs.attributes(full)
            if ea then
                table.insert(list, { name = entry, attr = ea })
            end
        end
    end
    table.sort(list, function(a, b)
        local ad = (a.attr.mode == "directory")
        local bd = (b.attr.mode == "directory")
        if ad ~= bd then return ad end
        return a.name:lower() < b.name:lower()
    end)
    return list, "directory"
end

local function handle_command(client, line)
    line = line:gsub("\r$", "")
    if line == "" then return end

    local cmd, arg = line:match("^([A-Za-z]+)%s*(.*)$")
    if not cmd then
        reply(client, 500, "Syntax error, command unrecognized.")
        return
    end
    cmd = cmd:upper()
    arg = arg or ""

    if cmd == "USER" then
        client.user = (arg ~= "" and arg) or "anonymous"
        reply(client, 331, "User name okay, send password.")
    elseif cmd == "PASS" then
        client.authed = true
        reply(client, 230, "User logged in, proceed.")
    elseif cmd == "ACCT" then
        reply(client, 202, "ACCT not needed.")
    elseif cmd == "SYST" then
        reply(client, 215, "UNIX Type: L8")
    elseif cmd == "FEAT" then
        local feat_resp = table.concat({
            "211-Features:\r\n",
            " PASV\r\n",
            " EPSV\r\n",
            " UTF8\r\n",
            " SIZE\r\n",
            " MDTM\r\n",
            " REST STREAM\r\n",
            " MLST type*;size*;modify*;perm*;\r\n",
            " MLSD\r\n",
            " TVFS\r\n",
            "211 End\r\n"
        })
        send_all(client.sock, feat_resp)
    elseif cmd == "OPTS" then
        reply(client, 200, "UTF8 mode enabled.")
    elseif cmd == "NOOP" then
        reply(client, 200, "NOOP ok.")
    elseif cmd == "ALLO" then
        reply(client, 200, "ALLO ok.")
    elseif cmd == "SITE" then
        reply(client, 200, "SITE command successful.")
    elseif cmd == "HELP" then
        reply(client, 214, "Kobo Wireless Studio FTP Server (LuaJIT).")
    elseif cmd == "TYPE" then
        client.type = arg:upper()
        reply(client, 200, "Type set to " .. (client.type ~= "" and client.type or "I") .. ".")
    elseif cmd == "MODE" then
        reply(client, 200, "Mode S ok.")
    elseif cmd == "STRU" then
        reply(client, 200, "Structure F ok.")
    elseif cmd == "REIN" then
        close_data(client)
        client.cwd = "/"
        reply(client, 220, "Service ready for new user.")
    elseif cmd == "QUIT" then
        reply(client, 221, "Goodbye.")
        close_client(client)
    elseif cmd == "ABOR" then
        close_data(client)
        reply(client, 226, "Abort successful.")
    elseif cmd == "PWD" or cmd == "XPWD" then
        local safe_cwd = (client.cwd or "/"):gsub('"', '""')
        reply(client, 257, string.format('"%s" is the current directory.', safe_cwd))
    elseif cmd == "CWD" or cmd == "XCWD" then
        local vpath, rpath = resolve_ftp_path(client.cwd, arg)
        if lfs.attributes(rpath, "mode") == "directory" then
            client.cwd = vpath
            reply(client, 250, "Directory successfully changed.")
        else
            reply(client, 550, "Failed to change directory.")
        end
    elseif cmd == "CDUP" or cmd == "XCUP" then
        local vpath, rpath = resolve_ftp_path(client.cwd, "..")
        if lfs.attributes(rpath, "mode") == "directory" then
            client.cwd = vpath
            reply(client, 250, "Directory successfully changed.")
        else
            client.cwd = "/"
            reply(client, 250, "Directory successfully changed.")
        end
    elseif cmd == "PASV" then
        close_data(client)
        local srv = socket.tcp()
        srv:setoption("reuseaddr", true)
        local ok, err = srv:bind("0.0.0.0", 0)
        if not ok then
            pcall(function() srv:close() end)
            reply(client, 425, "Cannot open passive connection: " .. tostring(err))
            return
        end
        srv:listen(8)
        local _, port = srv:getsockname()
        port = tonumber(port) or 0
        local ip = detect_local_ip(client.sock)
        local h1, h2, h3, h4 = ip:match("^(%d+)%.(%d+)%.(%d+)%.(%d+)$")
        if not h1 then
            h1, h2, h3, h4 = "127", "0", "0", "1"
        end
        local p1 = math.floor(port / 256)
        local p2 = port % 256
        client.pasv_srv = srv
        reply(client, 227, string.format("Entering Passive Mode (%s,%s,%s,%s,%d,%d).", h1, h2, h3, h4, p1, p2))
    elseif cmd == "EPSV" then
        close_data(client)
        local srv = socket.tcp()
        srv:setoption("reuseaddr", true)
        local ok, err = srv:bind("0.0.0.0", 0)
        if not ok then
            pcall(function() srv:close() end)
            reply(client, 425, "Cannot open extended passive connection: " .. tostring(err))
            return
        end
        srv:listen(8)
        local _, port = srv:getsockname()
        port = tonumber(port) or 0
        client.pasv_srv = srv
        reply(client, 229, string.format("Entering Extended Passive Mode (|||%d|).", port))
    elseif cmd == "PORT" then
        close_data(client)
        local h1, h2, h3, h4, p1, p2 = arg:match("^(%d+),(%d+),(%d+),(%d+),(%d+),(%d+)$")
        if not h1 then
            reply(client, 501, "Illegal PORT command.")
            return
        end
        client.port_ip = string.format("%s.%s.%s.%s", h1, h2, h3, h4)
        client.port_port = tonumber(p1) * 256 + tonumber(p2)
        reply(client, 200, "PORT command successful.")
    elseif cmd == "EPRT" then
        close_data(client)
        local d = arg:sub(1, 1)
        if d ~= "" then
            local p1 = arg:find(d, 2, true)
            local p2 = p1 and arg:find(d, p1 + 1, true)
            local p3 = p2 and arg:find(d, p2 + 1, true)
            if p1 and p2 and p3 then
                local ip = arg:sub(p1 + 1, p2 - 1)
                local port = tonumber(arg:sub(p2 + 1, p3 - 1))
                if ip ~= "" and port then
                    client.port_ip = ip
                    client.port_port = port
                    reply(client, 200, "EPRT command successful.")
                    return
                end
            end
        end
        reply(client, 501, "Illegal EPRT command.")
    elseif cmd == "LIST" or cmd == "NLST" or cmd == "MLSD" then
        local clean_arg = (cmd == "MLSD") and arg or strip_list_flags(arg)
        local vpath, rpath = resolve_ftp_path(client.cwd, clean_arg)
        local entries = collect_dir_entries(vpath, rpath)
        if not entries then
            close_data(client)
            reply(client, 550, "Directory not found.")
            return
        end
        local chunks = {}
        for i = 1, #entries do
            local item = entries[i]
            if cmd == "NLST" then
                chunks[i] = item.name .. "\r\n"
            elseif cmd == "MLSD" then
                chunks[i] = format_mlsd_line(item.name, item.attr)
            else
                chunks[i] = format_ls_line(item.name, item.attr)
            end
        end
        local payload = table.concat(chunks)
        reply(client, 150, "Here comes the directory listing.")
        local ds, err = open_data_sock(client)
        if not ds then
            reply(client, 425, "Can't open data connection: " .. tostring(err))
            return
        end
        send_all(ds, payload)
        pcall(function() ds:close() end)
        reply(client, 226, "Directory send OK.")
    elseif cmd == "MLST" then
        local vpath, rpath = resolve_ftp_path(client.cwd, arg)
        local attr = lfs.attributes(rpath)
        if not attr then
            reply(client, 550, "File or directory not found.")
            return
        end
        local line_info = format_mlsd_line(vpath, attr)
        local resp = "250-Listing " .. vpath .. "\r\n " .. line_info .. "250 End\r\n"
        send_all(client.sock, resp)
    elseif cmd == "STAT" then
        if arg == "" then
            reply(client, 211, "Kobo Wireless Studio FTP Server status OK.")
        else
            local clean_arg = strip_list_flags(arg)
            local vpath, rpath = resolve_ftp_path(client.cwd, clean_arg)
            local entries = collect_dir_entries(vpath, rpath)
            if not entries then
                reply(client, 550, "Path not found.")
                return
            end
            local chunks = { "213-Status of " .. vpath .. ":\r\n" }
            for i = 1, #entries do
                table.insert(chunks, " " .. format_ls_line(entries[i].name, entries[i].attr))
            end
            table.insert(chunks, "213 End of status.\r\n")
            send_all(client.sock, table.concat(chunks))
        end
    elseif cmd == "SIZE" then
        local _, rpath = resolve_ftp_path(client.cwd, arg)
        local attr = lfs.attributes(rpath)
        if attr and attr.mode == "file" then
            reply(client, 213, tostring(attr.size or 0))
        else
            reply(client, 550, "Could not get file size.")
        end
    elseif cmd == "MDTM" then
        local _, rpath = resolve_ftp_path(client.cwd, arg)
        local attr = lfs.attributes(rpath)
        if attr and attr.mode == "file" then
            local ts = os.date("!%Y%m%d%H%M%S", attr.modification or os.time())
            reply(client, 213, ts)
        else
            reply(client, 550, "Could not get modification time.")
        end
    elseif cmd == "REST" then
        client.rest_offset = tonumber(arg) or 0
        reply(client, 350, string.format("Restarting at %d. Send STORE or RETRIEVE to initiate transfer.", client.rest_offset))
    elseif cmd == "RETR" then
        local _, rpath = resolve_ftp_path(client.cwd, arg)
        local attr = lfs.attributes(rpath)
        if not attr or attr.mode ~= "file" then
            close_data(client)
            reply(client, 550, "Failed to open file.")
            return
        end
        local f = io.open(rpath, "rb")
        if not f then
            close_data(client)
            reply(client, 550, "Failed to open file.")
            return
        end
        if client.rest_offset and client.rest_offset > 0 then
            pcall(function() f:seek("set", client.rest_offset) end)
            client.rest_offset = 0
        end
        reply(client, 150, string.format("Opening BINARY mode data connection for %s (%d bytes).", arg, attr.size or 0))
        local ds, err = open_data_sock(client)
        if not ds then
            f:close()
            reply(client, 425, "Can't open data connection: " .. tostring(err))
            return
        end
        local ok_send = true
        while true do
            local chunk = f:read(65536)
            if not chunk or #chunk == 0 then break end
            local ok = send_all(ds, chunk)
            if not ok then
                ok_send = false
                break
            end
        end
        f:close()
        pcall(function() ds:close() end)
        if ok_send then
            reply(client, 226, "Transfer complete.")
        else
            reply(client, 426, "Connection closed; transfer aborted.")
        end
    elseif cmd == "STOR" or cmd == "APPE" then
        if arg == "" then
            close_data(client)
            reply(client, 553, "File name required.")
            return
        end
        local vpath, rpath = resolve_ftp_path(client.cwd, arg)
        ensure_parent_dirs(rpath)
        local open_mode = "wb"
        local offset = client.rest_offset or 0
        client.rest_offset = 0
        if cmd == "APPE" then
            open_mode = "ab"
        elseif offset > 0 and lfs.attributes(rpath, "mode") == "file" then
            open_mode = "r+b"
        end
        local f = io.open(rpath, open_mode)
        if not f then
            f = io.open(rpath, "wb")
        end
        if not f then
            close_data(client)
            reply(client, 550, "Cannot create file.")
            return
        end
        if offset > 0 and open_mode == "r+b" then
            pcall(function() f:seek("set", offset) end)
        end
        reply(client, 150, "Ok to send data.")
        local ds, err = open_data_sock(client)
        if not ds then
            f:close()
            reply(client, 425, "Can't open data connection: " .. tostring(err))
            return
        end
        local timeouts = 0
        while true do
            local chunk, rerr, partial = ds:receive(65536)
            local data = chunk or partial
            if data and #data > 0 then
                f:write(data)
                timeouts = 0
            end
            if not chunk then
                if rerr == "timeout" then
                    timeouts = timeouts + 1
                    if timeouts > 3 then break end
                else
                    break
                end
            end
        end
        f:flush()
        f:close()
        pcall(function() ds:close() end)
        pcall(sync_screensaver_mirror, vpath, rpath, false)
        reply(client, 226, "Transfer complete.")
    elseif cmd == "DELE" then
        local vpath, rpath = resolve_ftp_path(client.cwd, arg)
        if lfs.attributes(rpath, "mode") == "file" then
            local ok = os.remove(rpath)
            if ok then
                pcall(sync_screensaver_mirror, vpath, rpath, true)
                reply(client, 250, "Delete operation successful.")
                return
            end
        end
        reply(client, 550, "Delete operation failed.")
    elseif cmd == "MKD" or cmd == "XMKD" then
        if arg == "" then
            reply(client, 501, "Missing directory name.")
            return
        end
        local vpath, rpath = resolve_ftp_path(client.cwd, arg)
        ensure_parent_dirs(rpath)
        local ok = lfs.mkdir(rpath)
        if ok or lfs.attributes(rpath, "mode") == "directory" then
            local safe_vpath = vpath:gsub('"', '""')
            reply(client, 257, string.format('"%s" created.', safe_vpath))
        else
            reply(client, 550, "Create directory operation failed.")
        end
    elseif cmd == "RMD" or cmd == "XRMD" then
        if arg == "" then
            reply(client, 501, "Missing directory name.")
            return
        end
        local vpath, rpath = resolve_ftp_path(client.cwd, arg)
        if vpath == "/" or rpath == ROOT then
            reply(client, 550, "Cannot remove root directory.")
            return
        end
        local ok = lfs.rmdir(rpath)
        if ok then
            reply(client, 250, "Remove directory operation successful.")
        else
            reply(client, 550, "Remove directory failed (directory may not be empty).")
        end
    elseif cmd == "RNFR" then
        local _, rpath = resolve_ftp_path(client.cwd, arg)
        if lfs.attributes(rpath) then
            client.rnfr = rpath
            reply(client, 350, "Ready for RNTO.")
        else
            client.rnfr = nil
            reply(client, 550, "RNFR target does not exist.")
        end
    elseif cmd == "RNTO" then
        if not client.rnfr then
            reply(client, 503, "RNFR required first.")
            return
        end
        local _, rpath = resolve_ftp_path(client.cwd, arg)
        ensure_parent_dirs(rpath)
        os.remove(rpath)
        local ok = os.rename(client.rnfr, rpath)
        client.rnfr = nil
        if ok then
            reply(client, 250, "Rename successful.")
        else
            reply(client, 550, "Rename failed.")
        end
    else
        reply(client, 502, "Command not implemented.")
    end
end

local server = assert(socket.tcp())
server:setoption("reuseaddr", true)
assert(server:bind("0.0.0.0", PORT))
assert(server:listen(32))
server:settimeout(0)

print(string.format("[ftpd] Listening on 0.0.0.0:%d", PORT))

local clients = {}
local sock_to_client = {}

while true do
    local recvt = { server }
    local now = os.time()

    for i = #clients, 1, -1 do
        local c = clients[i]
        if c.closed or not c.sock or (now - (c.last_active or now) > 900) then
            if c.sock then sock_to_client[c.sock] = nil end
            close_client(c)
            table.remove(clients, i)
        else
            table.insert(recvt, c.sock)
        end
    end

    local ready = socket.select(recvt, nil, 2.0)
    if ready then
        for _, s in ipairs(ready) do
            if s == server then
                local csock = server:accept()
                if csock then
                    csock:settimeout(5)
                    pcall(function() csock:setoption("tcp-nodelay", true) end)
                    local c = {
                        sock = csock,
                        cwd = "/",
                        user = "anonymous",
                        authed = true,
                        type = "I",
                        rest_offset = 0,
                        last_active = os.time(),
                        closed = false,
                    }
                    table.insert(clients, c)
                    sock_to_client[csock] = c
                    reply(c, 220, "Kobo Wireless Studio FTP Server Ready.")
                end
            else
                local c = sock_to_client[s]
                if c and not c.closed then
                    c.last_active = os.time()
                    local line, err = s:receive("*l")
                    if line then
                        local ok_cmd, cmd_err = pcall(handle_command, c, line)
                        if not ok_cmd then
                            io.stderr:write("[ftpd] cmd error: " .. tostring(cmd_err) .. "\n")
                            reply(c, 550, "Internal server error.")
                        end
                    elseif err == "closed" then
                        close_client(c)
                    end
                end
            end
        end
    end
end
