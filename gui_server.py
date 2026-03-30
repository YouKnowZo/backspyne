import asyncio
import subprocess
import os
import threading
import platform
import psutil
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from bleak import BleakScanner
import uvicorn

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

latest_scan = {
    "wifi": [],
    "bluetooth": []
}

def get_system_specs():
    return {
        "hostname": platform.node(),
        "os": platform.system(),
        "os_release": platform.release(),
        "cpu_cores": psutil.cpu_count(logical=True),
        "cpu_usage_percent": psutil.cpu_percent(interval=None),
        "ram_total_gb": round(psutil.virtual_memory().total / (1024**3), 2),
        "ram_usage_percent": psutil.virtual_memory().percent,
    }

def get_wifi_devices():
    devices = []
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
                    devices.append({
                        "type": "Wi-Fi",
                        "name": current_ssid if current_ssid else "Hidden Network",
                        "address": bssid,
                        "signal": signal,
                        "rssi": int(signal.replace('%', ''))
                    })
    except:
        pass
    return devices

async def scan_loop():
    print("Mesh Scanner node loop started. Press Ctrl+C to terminate.")
    while True:
        try:
            wifi_devices = get_wifi_devices()
            wifi_devices.sort(key=lambda x: x['rssi'], reverse=True)
            latest_scan["wifi"] = wifi_devices
            
            ble_devices = await BleakScanner.discover(timeout=2.0, return_adv=True)
            bt_devices = []
            for addr, (device, adv_data) in ble_devices.items():
                bt_devices.append({
                    "type": "Bluetooth",
                    "name": device.name if device.name else "Unknown Device",
                    "address": addr,
                    "signal": f"{adv_data.rssi} dBm",
                    "rssi": adv_data.rssi
                })
            bt_devices.sort(key=lambda x: x['rssi'], reverse=True)
            latest_scan["bluetooth"] = bt_devices
        except Exception as e:
            pass
        await asyncio.sleep(1)

def start_background_loop(loop):
    asyncio.set_event_loop(loop)
    loop.run_until_complete(scan_loop())

@app.on_event("startup")
async def startup_event():
    # Start the scanning loop in a background thread
    loop = asyncio.new_event_loop()
    t = threading.Thread(target=start_background_loop, args=(loop,), daemon=True)
    t.start()
    # initialize psutil CPU percentage
    psutil.cpu_percent(interval=None)

@app.get("/api/scan")
def get_scan_data():
    return {
        "node_specs": get_system_specs(),
        "scan_data": latest_scan
    }

if __name__ == "__main__":
    print("Starting API Server. Mesh Nodes can communicate via this port.")
    uvicorn.run("gui_server:app", host="0.0.0.0", port=8000, reload=False)
