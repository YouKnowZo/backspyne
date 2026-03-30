import asyncio
import subprocess
import os
import threading
import platform
import psutil
import time
from fastapi import FastAPI
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

# Persistent Tracking Dictionary
discovered_devices = {
    "wifi": {},
    "bluetooth": {}
}

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
                        discovered_devices["wifi"][bssid] = {
                            "type": "Wi-Fi",
                            "name": current_ssid if current_ssid else "Hidden Network",
                            "address": bssid,
                            "signal": signal,
                            "rssi": rssi,
                            "vendor": vendor,
                            "last_seen": int(time.time()),
                            "active": True
                        }
    except Exception as e:
        print("Wi-Fi Scan Error:", e)

async def scan_loop():
    print("BackSpyne Engine Started. Press Ctrl+C to terminate.")
    
    # Pre-load mac lookup database
    try:
        await mac_lookup.update_vendors()
    except Exception:
        print("Could not download latest MAC OUI database. Continuing.")
        pass

    while True:
        try:
            # Mark all as inactive temporarily
            for t in discovered_devices.keys():
                for mac in discovered_devices[t]:
                    discovered_devices[t][mac]["active"] = False

            await scan_wifi_devices()
            
            ble_devices = await BleakScanner.discover(timeout=2.0, return_adv=True)
            for addr, (device, adv_data) in ble_devices.items():
                vendor = await get_vendor_name(addr)
                discovered_devices["bluetooth"][addr] = {
                    "type": "Bluetooth",
                    "name": device.name if device.name else "Unknown Device",
                    "address": addr,
                    "signal": f"{adv_data.rssi} dBm",
                    "rssi": adv_data.rssi,
                    "vendor": vendor,
                    "last_seen": int(time.time()),
                    "active": True
                }
                
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
    psutil.cpu_percent(interval=None)

@app.get("/api/scan")
def get_scan_data():
    return {
        "node_specs": get_system_specs(),
        "scan_data": discovered_devices
    }

if __name__ == "__main__":
    print("Starting BackSpyne Engine.")
    uvicorn.run("gui_server:app", host="0.0.0.0", port=8000, reload=False)
