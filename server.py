import asyncio
import subprocess
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from bleak import BleakScanner
import threading

app = FastAPI()

# Allow CORS for the local web app
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # In a real app restrict this
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global state to hold latest scan results
latest_scan = {
    "wifi": [],
    "bluetooth": []
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
    except Exception as e:
        print("Wi-Fi Scan Error:", e)
    return devices

async def scan_loop():
    print("Scanner background loop started.")
    while True:
        try:
            wifi_devices = get_wifi_devices()
            wifi_devices.sort(key=lambda x: x['rssi'], reverse=True)
            latest_scan["wifi"] = wifi_devices
            
            bt_devices = []
            ble_devices = await BleakScanner.discover(timeout=3.0, return_adv=True)
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
            print("Scan error:", e)
        await asyncio.sleep(1)

def start_background_loop(loop: asyncio.AbstractEventLoop):
    asyncio.set_event_loop(loop)
    loop.run_until_complete(scan_loop())

@app.on_event("startup")
async def startup_event():
    loop = asyncio.new_event_loop()
    t = threading.Thread(target=start_background_loop, args=(loop,), daemon=True)
    t.start()

@app.get("/api/scan")
def get_scan_data():
    return latest_scan

if __name__ == "__main__":
    import uvicorn
    # Host on 0.0.0.0 to allow mobile phone on same network to access
    uvicorn.run(app, host="0.0.0.0", port=8000)
