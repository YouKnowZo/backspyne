# BackSpyne 🛡️ - Advanced Live Tracker

**BackSpyne** is a military-inspired, high-grade Progressive Web App (PWA) and Python engine designed to locate, identify, and track hidden electronics using localized signal intelligence. 

By aggressively analyzing radio frequency patterns of Wi-Fi Access Points and Bluetooth Low Energy (BLE) emissions, BackSpyne lets you map devices broadcasting instantly around you, decode their MAC hardware Manufacturer, and definitively track them down using Sonar-like targeting.

✨ **Core Features** ✨
1. **Sonar Target Tracking Mode**: Click any device to lock on. A large animated radar focuses entirely on tracking that single MAC address, emitting an audible Sonar Ping that increases in speed and pitch as you close in on the hidden device.
2. **Persistent Ghost Tracking**: BackSpyne remembers devices even after they stop broadcasting, labeling them "Target Lost" so you have a complete historical record of what was scanning you. 
3. **Hardware Decoding**: Utilizes OUI MAC Decoders to identify if a mysterious network is an Apple, Samsung, Intel, or other vendor chip.
4. **Data Exfiltration / CSV Export**: With one click, download a complete Excel/CSV report of every tracked device, its vendor, and maximum proximity detected to your PC.
5. **Distributed Mesh Nodes**: Combine multiple computers (scanners) via IP across your property directly into one single unified Radar Dashboard map.

## Installation & Setup 💻 (The Engine)

### Requirements:
1. Python 3.9+ 
2. Build-in Wi-Fi & Bluetooth PC Adapters.

### Startup Guide:

1. Look in the main folder for `requirements.txt`. Install the required python packages by running:
```bash
pip install -r requirements.txt
```
2. Double-click the included `start_gui.bat`. This automatically opens your dashboard and your Python API server simultaneously.

*NOTE*: Upon successful boot, look at your Node Terminal window. It will expose a Local IP like `http://192.168.1.15:5173`. That is the portal specific to your mobile phone!

## Android & iOS (The Remote UI) 📱 

Because this application dynamically surfaces itself over your local Wi-Fi, turning your phone into the ultimate remote-control tracker is incredibly simple.

1. Connect your Android or iOS device to the **SAME Wi-Fi network** as the scanning PC.
2. Open Safari (iOS) or Chrome (Android) and type the specific IP address exposed by the `start_gui` command (for example: `http://192.168.1.15:5173`).
3. The stunning BackSpyne radar UI will load identically on your phone!

**How to fully "Install" the app on your Phone:**
BackSpyne is deeply compliant as a PWA (Progressive Web Application).
- **Apple (iOS/Safari)**: Tap the "Share" icon at the bottom center of Safari, scroll down to the actions list, and tap **"Add to Home Screen"**. 
- **Android**: Tap the URL three-dots menu icon and tap **"Install App"**.

## Combining Nodes 🚀 (Advanced Tracing)
A single node tells you signal strength. Multiple nodes tell you *exact* origins. 

1. Install this Github repository on a second laptop or PC over the network.
2. Open `start_gui.bat` on the *second* platform. Note its specific IP address shown in its console.
3. Open the Dashboard UI, scroll to the **Networked Nodes**, and type the second platform's IP. Press **"Combine Node"**.

---
**Disclaimer**: This is a defensive privacy tool. Do not scan infrastructure you do not have authorizations on.
