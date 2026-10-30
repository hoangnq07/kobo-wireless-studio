#!/bin/sh
export PATH="/sbin:/usr/sbin:/bin:/usr/bin"

SNAP_LOG="/mnt/onboard/.adds/tools/wifi_debug.log"
RUN_LOG="/tmp/kobo_wifi_runtime.log"
WEB_PID_FILE="/tmp/kobo_webfiles.pid"
FTP_PID_FILE="/tmp/kobo_ftpd.pid"
KA_PID_FILE="/tmp/kobo_wifi_ka.pid"

disable_wifi_powersave() {
    for IF in eth0 wlan0; do
        if /sbin/ifconfig "$IF" 2>/dev/null | grep -q "UP"; then
            /sbin/iwconfig "$IF" power off 2>/dev/null
            /usr/sbin/iwconfig "$IF" power off 2>/dev/null
            wlarm_le -i "$IF" PM 0 2>/dev/null
            /sbin/wlarm_le -i "$IF" PM 0 2>/dev/null
            /usr/sbin/wlarm_le -i "$IF" PM 0 2>/dev/null
        fi
    done
}

# Clean up any previous keepalive worker
if [ -f "$KA_PID_FILE" ]; then
    KPID=$(cat "$KA_PID_FILE" 2>/dev/null)
    [ -n "$KPID" ] && kill "$KPID" 2>/dev/null
    rm -f "$KA_PID_FILE"
fi

# 1. Toggle OFF if already running (never touches the user's Wi-Fi master switch)
STOPPED=0
if [ -f "$WEB_PID_FILE" ]; then
    WPID=$(cat "$WEB_PID_FILE" 2>/dev/null)
    if [ -n "$WPID" ] && kill -0 "$WPID" 2>/dev/null; then
        kill "$WPID" 2>/dev/null
        STOPPED=1
    fi
    rm -f "$WEB_PID_FILE"
fi
if pkill -f "webfiles.lua" 2>/dev/null; then
    STOPPED=1
fi
if [ -f "$FTP_PID_FILE" ]; then
    FPID=$(cat "$FTP_PID_FILE" 2>/dev/null)
    if [ -n "$FPID" ] && kill -0 "$FPID" 2>/dev/null; then
        kill "$FPID" 2>/dev/null
        STOPPED=1
    fi
    rm -f "$FTP_PID_FILE"
fi
if pkill -f "tcpsvd -E 0.0.0.0 1021" 2>/dev/null; then
    STOPPED=1
fi

if [ "$STOPPED" -eq 1 ]; then
    echo "Đã TẮT Web (:8080) & FTP (:1021)!"
    exit 0
fi

# 2. Initialize runtime log in /tmp (RAM) so /mnt/onboard is never held open during USB mount
echo "=== Wireless Studio Runtime $(date) ===" > "$RUN_LOG"
disable_wifi_powersave

# 3. Set local FTP password 'kobo' for account 'root'
KOBO_HASH='$1$kobo2026$Kc8fD66oCt5khtyrZ1ekE0'
if [ -f /etc/shadow ]; then
    [ -f /etc/shadow.kobo.bak ] || cp -pf /etc/shadow /etc/shadow.kobo.bak 2>/dev/null
    awk -F: -v OFS=: -v h="$KOBO_HASH" '$1=="root"{$2=h} {print}' /etc/shadow > /tmp/shadow.kobo.tmp && \
        cp -f /tmp/shadow.kobo.tmp /etc/shadow && rm -f /tmp/shadow.kobo.tmp
else
    [ -f /etc/passwd.kobo.bak ] || cp -pf /etc/passwd /etc/passwd.kobo.bak 2>/dev/null
    awk -F: -v OFS=: -v h="$KOBO_HASH" '$1=="root"{$2=h} {print}' /etc/passwd > /tmp/passwd.kobo.tmp && \
        cp -f /tmp/passwd.kobo.tmp /etc/passwd && rm -f /tmp/passwd.kobo.tmp
fi

# 4. Launch Web Studio (:8080) — webfiles.lua immediately chdirs to /tmp after loading libs
(
    cd /mnt/onboard/.adds/koreader || exit 1
    export LD_LIBRARY_PATH="/mnt/onboard/.adds/koreader/libs:${LD_LIBRARY_PATH}"
    exec /mnt/onboard/.adds/koreader/luajit /mnt/onboard/.adds/tools/webfiles.lua
) </dev/null >>"$RUN_LOG" 2>&1 &
WPID=$!
echo "$WPID" > "$WEB_PID_FILE"

# 5. Launch BusyBox FTP Server (:1021) with cwd in /tmp
(
    cd /tmp || exit 1
    exec /usr/bin/tcpsvd -E 0.0.0.0 1021 /usr/sbin/ftpd -w -t 600 /mnt/onboard
) </dev/null >>"$RUN_LOG" 2>&1 &
echo $! > "$FTP_PID_FILE"

# 6. Dual-band Smart-Connect router bridge & ARP keepalive while service is active
(
    cd /tmp || exit 1
    while [ -f "$WEB_PID_FILE" ] && kill -0 "$WPID" 2>/dev/null; do
        disable_wifi_powersave
        IFACE=$(/sbin/route -n 2>/dev/null | /usr/bin/awk '$1=="0.0.0.0"{print $8; exit}')
        GW=$(/sbin/route -n 2>/dev/null | /usr/bin/awk '$1=="0.0.0.0"{print $2; exit}')
        CUR_IP=""
        if [ -n "$IFACE" ]; then
            CUR_IP=$(/sbin/ifconfig "$IFACE" 2>/dev/null | /usr/bin/awk '/inet addr:/{sub(/.*inet addr:/,""); sub(/ .*/,""); print; exit}')
        fi
        if [ -n "$GW" ]; then
            /bin/ping -c 1 -W 1 "$GW" >/dev/null 2>&1
        fi
        for PEER in $(/usr/bin/awk 'NR>1 && $4!="00:00:00:00:00:00"{print $1}' /proc/net/arp 2>/dev/null | head -n 3); do
            [ "$PEER" != "$GW" ] && /bin/ping -c 1 -W 1 "$PEER" >/dev/null 2>&1
        done
        if [ -n "$IFACE" ] && [ -n "$CUR_IP" ] && command -v arping >/dev/null 2>&1; then
            arping -U -c 1 -w 1 -I "$IFACE" "$CUR_IP" >/dev/null 2>&1
        fi
        sleep 8
    done
) </dev/null >/dev/null 2>&1 &
echo $! > "$KA_PID_FILE"

# 7. Wait up to ~2s (8 x 0.25s) verifying ports 8080 (1F90) and 1021 (03FD) are listening
i=0
WEB_OK=0
FTP_OK=0
while [ "$i" -lt 8 ]; do
    WEB_OK=0
    FTP_OK=0
    grep -qi ":1F90 " /proc/net/tcp /proc/net/tcp6 2>/dev/null && WEB_OK=1
    grep -qi ":03FD " /proc/net/tcp /proc/net/tcp6 2>/dev/null && FTP_OK=1
    if [ "$WEB_OK" -eq 1 ] && [ "$FTP_OK" -eq 1 ]; then
        break
    fi
    usleep 250000 2>/dev/null || sleep 1
    i=$((i + 1))
done

IP=$(/sbin/ifconfig 2>/dev/null | /usr/bin/awk '/inet addr:/ && !/127\.0\.0\.1/{sub(/.*inet addr:/,""); sub(/ .*/,""); print; exit}')
if [ -z "$IP" ]; then
    IP=$(/sbin/ifconfig 2>/dev/null | /usr/bin/awk '/inet / && !/127\.0\.0\.1/{for(i=1;i<=NF;i++) if($i=="inet"){print $(i+1); exit}}')
fi

SSID=$(wpa_cli status 2>/dev/null | /usr/bin/awk -F= '$1=="ssid"{print $2; exit}')
[ -z "$SSID" ] && SSID=$(iwgetid -r 2>/dev/null)

if [ "$WEB_OK" -eq 1 ] && [ "$FTP_OK" -eq 1 ]; then
    if [ -n "$IP" ]; then
        echo "ĐÃ BẬT WEB & FTP QUA WI-FI!"
        if [ -n "$SSID" ]; then
            echo "Wi-Fi: ${SSID}  |  IP: ${IP}"
        else
            echo "IP hiện tại: ${IP}"
        fi
        echo ""
        echo "1. Web Studio:"
        echo "   http://${IP}:8080"
        echo ""
        echo "2. FTP (File Explorer / FileZilla):"
        echo "   ftp://root:kobo@${IP}:1021"
        echo "   (TK: root  |  Mật khẩu: kobo)"
    else
        echo "CHÚ Ý: KOBO CHƯA CÓ IP WI-FI!"
        echo "(Web :8080 & FTP :1021 đã bật chờ sẵn)"
        echo ""
        echo "Hãy bật Wi-Fi nối mạng trước, sau đó bấm Tắt rồi Bật lại mục này để xem đúng địa chỉ IP."
    fi
else
    echo "CẢNH BÁO: Web=${WEB_OK}, FTP=${FTP_OK}"
    tail -n 6 "$RUN_LOG" 2>/dev/null
fi
