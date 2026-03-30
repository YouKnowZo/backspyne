import asyncio
import subprocess
import os
import threading
import platform
import psutil
import time
import socket
import sqlite3
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from bleak import BleakScanner
import uvicorn
from mac_vendor_lookup import AsyncMacLookup

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

mac_lookup = AsyncMacLookup()
vendor_cache = {}

discovered_devices = {
    "wifi": {},
    "bluetooth": {}
}

DB_NAME = "backspyne.db"

def init_db():
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS devices
                 (mac TEXT PRIMARY KEY, type TEXT, name TEXT, vendor TEXT, last_seen INTEGER, max_rssi INTEGER)''')
    conn.commit()
    conn.close()

def load_db():
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute("SELECT mac, type, name, vendor, last_seen, max_rssi FROM devices")
    rows = c.fetchall()
    conn.close()
    
    for row in rows:
        mac, type_, name, vendor, last_seen, max_rssi = row
        t = "wifi" if type_ == "Wi-Fi" else "bluetooth"
        discovered_devices[t][mac] = {
            "type": type_,
            "name": name,
            "address": mac,
            "signal": f"{max_rssi}%" if type_ == "Wi-Fi" else f"{max_rssi} dBm",
            "rssi": max_rssi,
            "vendor": vendor,
            "last_seen": last_seen,
            "active": False # It's a loaded ghost
        }
    print(f"Loaded {len(rows)} persistent ghost devices from deep storage DB.")

def save_device_to_db(d):
    try:
        conn = sqlite3.connect(DB_NAME)
        c = conn.cursor()
        c.execute("SELECT max_rssi FROM devices WHERE mac=?", (d["address"],))
        row = c.fetchone()
        
        # Keep the strongest historical signal strength
        best_rssi = d["rssi"]
        if row and row[0] > best_rssi:
            best_rssi = row[0]
            
        c.execute('''INSERT OR REPLACE INTO devices (mac, type, name, vendor, last_seen, max_rssi)
                     VALUES (?, ?, ?, ?, ?, ?)''', (d["address"], d["type"], d["name"], d["vendor"], d["last_seen"], best_rssi))
        conn.commit()
        conn.close()
    except Exception as e:
        print("DB Save Error:", e)

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                await connection.close()
                if connection in self.active_connections:
                    self.active_connections.remove(connection)

manager = ConnectionManager()

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "127.0.0.1"

async def get_vendor_name(mac_address):
    if mac_address in vendor_cache:
        return vendor_cache[mac_address]
    try:
        vendor = await mac_lookup.lookup(mac_address)
        vendor_cache[mac_address] = vendor
        return vendor
    except Exception:
        vendor_cache[mac_address] = "Unknown Manufacturer"
        return "Unknown Manufacturer"

def get_system_specs():
    return {
        "hostname": platform.node(),
        "ip_address": get_local_ip(),
        "os": platform.system(),
        "os_release": platform.release(),
        "cpu_cores": psutil.cpu_count(logical=True),
        "cpu_usage_percent": psutil.cpu_percent(interval=None),
        "ram_total_gb": round(psutil.virtual_memory().total / (1024**3), 2),
        "ram_usage_percent": psutil.virtual_memory().percent,
    }

async def scan_wifi_devices():
    try:
        result = subprocess.run(['netsh', 'wlan', 'show', 'networks', 'mode=bssid'], capture_output=True, text=True)
        output = result.stdout
        current_ssid = ""
        bssid = ""
        
        for line in output.split('\n'):
            line = line.strip()
            if line.startswith("SSID"):
                parts = line.split(":")
                if len(parts) > 1:
                    current_ssid = parts[1].strip()
            elif line.startswith("BSSID"):
                parts = line.split(":")
                if len(parts) > 1:
                    bssid = ":".join(parts[1:]).strip()
            elif line.startswith("Signal"):
                parts = line.split(":")
                if len(parts) > 1:
                    signal = parts[1].strip()
                    rssi = int(signal.replace('%', ''))
                    
                    if bssid:
                        vendor = await get_vendor_name(bssid)
                        new_dev = {
                            "type": "Wi-Fi",
                            "name": current_ssid if current_ssid else "Hidden Network",
                            "address": bssid,
                            "signal": signal,
                            "rssi": rssi,
                            "vendor": vendor,
                            "last_seen": int(time.time()),
                            "active": True
                        }
                        discovered_devices["wifi"][bssid] = new_dev
                        threading.Thread(target=save_device_to_db, args=(new_dev,)).start()
    except Exception as e:
        print("Wi-Fi Scan Error:", e)

async def scan_loop():
    print("BackSpyne Engine V2 (Persistent WebSockets) Started.")
    
    init_db()
    load_db()

    try:
        await mac_lookup.update_vendors()
    except Exception:
        pass

    while True:
        try:
            for t in discovered_devices.keys():
                for mac in discovered_devices[t]:
                    discovered_devices[t][mac]["active"] = False

            await scan_wifi_devices()
            
            ble_devices = await BleakScanner.discover(timeout=2.0, return_adv=True)
            for addr, (device, adv_data) in ble_devices.items():
                vendor = await get_vendor_name(addr)
                new_dev = {
                    "type": "Bluetooth",
                    "name": device.name if device.name else "Unknown Device",
                    "address": addr,
                    "signal": f"{adv_data.rssi} dBm",
                    "rssi": adv_data.rssi,
                    "vendor": vendor,
                    "last_seen": int(time.time()),
                    "active": True
                }
                discovered_devices["bluetooth"][addr] = new_dev
                threading.Thread(target=save_device_to_db, args=(new_dev,)).start()
                
        except Exception as e:
            pass
            
        # Push to all connected websockets
        payload = {
            "node_specs": get_system_specs(),
            "scan_data": discovered_devices
        }
        await manager.broadcast(payload)
        await asyncio.sleep(1)

def start_background_loop(loop):
    asyncio.set_event_loop(loop)
    loop.run_until_complete(scan_loop())

@app.on_event("startup")
async def startup_event():
    loop = asyncio.new_event_loop()
    t = threading.Thread(target=start_background_loop, args=(loop,), daemon=True)
    t.start()
    psutil.cpu_percent(interval=None)

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # We don't expect client to send anything, just keep conn alive
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

@app.get("/api/scan")
def get_scan_data():
    return {
        "node_specs": get_system_specs(),
        "scan_data": discovered_devices
    }

if __name__ == "__main__":
    ip = get_local_ip()
    print(f"\n=======================================================")
    print(f" BackSpyne Server V2 Live: Host IP is [{ip}] ")
    print(f" WebSockets Active. SQLite Persistence Active. ")
    print(f"=======================================================\n")
    uvicorn.run("gui_server:app", host="0.0.0.0", port=8000, reload=False)
