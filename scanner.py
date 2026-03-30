import asyncio
import subprocess
import os
from bleak import BleakScanner

# Function to parse Windows netsh command output for Wi-Fi networks
def get_wifi_devices():
    devices = []
    try:
        # standard windows command to get wifi details including BSSID and Signal
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
                        "rssi": int(signal.replace('%', '')) # percentage for sorting
                    })
    except Exception as e:
        pass
    return devices

async def scan():
    print("Initializing scanner...")
    
    while True:
        os.system('cls' if os.name == 'nt' else 'clear')
        print("=== Wireless Device Signal Tracker ===")
        print("Move your PC to detect changes in signal strength.")
        print("-> Higher Wi-Fi % means you are closer.")
        print("-> Bluetooth dBm closer to 0 means you are closer (e.g., -40 is stronger than -90).\n")
        
        # 1. Get Wi-Fi Devices
        print("Scanning Wi-Fi...")
        wifi_devices = get_wifi_devices()
        
        # 2. Get Bluetooth (BLE) Devices
        print("Scanning Bluetooth LE...")
        bt_devices = []
        try:
            # discover for roughly 3 seconds
            ble_devices = await BleakScanner.discover(timeout=3.0, return_adv=True)
            for addr, (device, adv_data) in ble_devices.items():
                bt_devices.append({
                    "type": "Bluetooth",
                    "name": device.name if device.name else "Unknown Device",
                    "address": addr,
                    "signal": f"{adv_data.rssi} dBm",
                    "rssi": adv_data.rssi
                })
        except Exception as e:
            print(f"Bluetooth scan error (Make sure Bluetooth is turned ON): {e}")
        
        os.system('cls' if os.name == 'nt' else 'clear')
        print("=== Wireless Device Signal Tracker ===")
        print("Update Interval: ~3 seconds | Press Ctrl+C to exit\n")
        
        print("--- Wi-Fi Devices (Signal Quality %) ---")
        # Sort Wi-Fi by signal % descending
        wifi_devices.sort(key=lambda x: x['rssi'], reverse=True)
        for d in wifi_devices:
            print(f"[{d['signal']:>4}] {d['address']:<17} : {d['name']}")
            
        print("\n--- Bluetooth LE Devices (RSSI dBm) ---")
        # Sort BT by RSSI descending
        bt_devices.sort(key=lambda x: x['rssi'], reverse=True)
        for d in bt_devices:
            print(f"[{d['signal']:>8}] {d['address']:<17} : {d['name']}")
            
        print("\nScanning again... (Do not close window)")

if __name__ == "__main__":
    try:
        asyncio.run(scan())
    except KeyboardInterrupt:
        print("\nScanner stopped.")
