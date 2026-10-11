// What this browser can and cannot measure.
//
// The console's honesty rule starts here: a browser cannot enumerate nearby radios, so every
// capability that would imply it is reported as limited or unsupported, with the reason, and
// permission is requested only when the operator asks for it. Probing returns a new list; it
// never touches React state.

import { isMobileProfile } from './format';
import type { HardwareCapability, HardwareStatus } from './types';

type HardwareNavigator = Navigator & {
  bluetooth?: {
    getAvailability?: () => Promise<boolean>;
    requestDevice?: (options: { acceptAllDevices: boolean }) => Promise<{ name?: string | null }>;
  };
  usb?: {
    getDevices?: () => Promise<unknown[]>;
    requestDevice?: (options: { filters: unknown[] }) => Promise<unknown>;
  };
  serial?: {
    getPorts?: () => Promise<unknown[]>;
    requestPort?: (options?: { filters?: unknown[] }) => Promise<unknown>;
  };
  connection?: { effectiveType?: string; downlink?: number };
};

export const initialHardware: HardwareCapability[] = [
  { id: 'bluetooth', label: 'Bluetooth radio', status: 'permission', detail: 'Radio detected. Choose an approved BLE peripheral to connect.', use: 'BLE discovery and local sensor adapters', action: 'bluetooth' },
  { id: 'wifi', label: 'WiFi awareness', status: 'limited', detail: 'The browser can report network state, but cannot enumerate nearby access points.', use: 'Use a local relay or ESP32 adapter for RF observations' },
  { id: 'motion', label: 'Motion sensors', status: 'ready', detail: 'Device motion and orientation APIs are available to this browser.', use: 'Optional device movement context for local sensing' },
  { id: 'camera-mic', label: 'Camera and microphone', status: 'permission', detail: 'Media inputs are present. BackSpyne will not request access automatically.', use: 'Optional operator presence checks; never used for RF sensing', action: 'camera-mic' },
  { id: 'usb', label: 'USB devices', status: 'unsupported', detail: 'No browser USB adapter is available until a device is explicitly selected.', use: 'Direct ESP32 or compatible scanner connection', action: 'usb' },
  { id: 'serial', label: 'Serial ports', status: 'unsupported', detail: 'No browser serial adapter is available until a port is explicitly selected.', use: 'Local Python bridge or microcontroller stream', action: 'serial' },
  { id: 'location', label: 'Location', status: 'permission', detail: 'Location is available only after an explicit user permission decision.', use: 'Optional node placement and operator map context', action: 'location' },
  { id: 'battery', label: 'Battery and power', status: 'ready', detail: 'Power state can help tune scan intensity on portable devices.', use: 'Adaptive polling and low-power mode' },
];

function find(capabilities: HardwareCapability[], id: string): HardwareCapability | undefined {
  return capabilities.find(capability => capability.id === id);
}

const STATUS_WORDS: Record<HardwareStatus, string> = {
  ready: 'ready',
  permission: 'permission needed',
  connected: 'connected',
  limited: 'limited',
  unsupported: 'not exposed',
};

/**
 * What one scan changed compared with the previous one. A scan that finds nothing new is
 * still a result, so an empty list is reported as exactly that by the caller rather than
 * being indistinguishable from a button that did nothing.
 */
export function describeHardwareChanges(previous: HardwareCapability[], next: HardwareCapability[]): string[] {
  const changes: string[] = [];
  for (const capability of next) {
    const before = previous.find(item => item.id === capability.id);
    if (!before) {
      changes.push(`${capability.label}: checked for the first time`);
      continue;
    }
    if (before.status !== capability.status) {
      changes.push(`${capability.label}: ${STATUS_WORDS[before.status]} → ${STATUS_WORDS[capability.status]}`);
      continue;
    }
    if (before.detail !== capability.detail) {
      changes.push(`${capability.label}: ${capability.detail}`);
    }
  }
  return changes;
}

/** Probes the browser for what it actually exposes and returns the updated catalog. */
export async function scanHardwareCapabilities(): Promise<HardwareCapability[]> {
  if (typeof navigator === 'undefined') return initialHardware;
  const hardwareNavigator = navigator as HardwareNavigator;
  const next = initialHardware.map(capability => ({ ...capability }));
  const mediaDevices = hardwareNavigator.mediaDevices;
  const isMobile = isMobileProfile();

  if (isMobile) {
    const cameraMic = find(next, 'camera-mic');
    if (cameraMic) {
      cameraMic.status = 'unsupported';
      cameraMic.detail = 'Camera and microphone are not used for RF scanning.';
    }
    const usb = find(next, 'usb');
    if (usb) {
      usb.status = 'unsupported';
      usb.detail = 'Mobile USB access is not used by this browser scanning profile.';
    }
    const serial = find(next, 'serial');
    if (serial) {
      serial.status = 'unsupported';
      serial.detail = 'Mobile serial access is not used by this browser scanning profile.';
    }
  }

  if (!isMobile && mediaDevices?.enumerateDevices) {
    try {
      const media = await mediaDevices.enumerateDevices();
      const cameras = media.filter(device => device.kind === 'videoinput').length;
      const microphones = media.filter(device => device.kind === 'audioinput').length;
      const cameraMic = find(next, 'camera-mic');
      if (cameraMic) {
        cameraMic.status = cameras + microphones > 0 ? 'permission' : 'limited';
        cameraMic.detail = cameras + microphones > 0
          ? `${cameras} camera${cameras === 1 ? '' : 's'} and ${microphones} microphone${microphones === 1 ? '' : 's'} reported. Access stays off by default.`
          : 'No camera or microphone inputs were reported.';
      }
    } catch {
      const cameraMic = find(next, 'camera-mic');
      if (cameraMic) cameraMic.detail = 'Media inputs could not be enumerated without permission.';
    }
  } else if (!isMobile) {
    const cameraMic = find(next, 'camera-mic');
    if (cameraMic) {
      cameraMic.status = 'unsupported';
      cameraMic.detail = 'Media device APIs are not available in this browser.';
    }
  }

  if (!isMobile && hardwareNavigator.bluetooth) {
    let available = true;
    try {
      available = hardwareNavigator.bluetooth.getAvailability ? await hardwareNavigator.bluetooth.getAvailability() : true;
    } catch {
      available = true;
    }
    const bluetooth = find(next, 'bluetooth');
    if (bluetooth) {
      bluetooth.status = available ? 'permission' : 'unsupported';
      bluetooth.detail = available
        ? 'Radio detected. Choose an approved BLE peripheral to connect.'
        : 'This browser does not report a Bluetooth radio.';
    }
  } else if (!isMobile) {
    const bluetooth = find(next, 'bluetooth');
    if (bluetooth) {
      bluetooth.status = 'unsupported';
      bluetooth.detail = 'Web Bluetooth is not available in this browser.';
    }
  }

  const motion = find(next, 'motion');
  if (motion) {
    const motionAvailable = typeof window !== 'undefined' && ('DeviceMotionEvent' in window || 'DeviceOrientationEvent' in window);
    motion.status = 'unsupported';
    motion.detail = motionAvailable
      ? 'Motion sensors are available but are not used for RF scanning.'
      : 'Motion sensors are not exposed by this browser and are not used for RF scanning.';
  }

  const location = find(next, 'location');
  if (location) {
    location.status = 'unsupported';
    location.detail = 'Location is not used for RF scanning.';
  }

  const battery = find(next, 'battery');
  if (battery) {
    battery.status = 'unsupported';
    battery.detail = 'Battery state is not used for RF scanning.';
  }

  const wifi = find(next, 'wifi');
  if (wifi) {
    // The one WiFi fact a browser does expose is the link this device is on, so the scan
    // reports it instead of leaving the card saying only what it cannot do.
    const link: string[] = [hardwareNavigator.onLine === false ? 'This device reports no network link' : 'This device reports an active network link'];
    if (hardwareNavigator.connection?.effectiveType) link.push(`link type ${hardwareNavigator.connection.effectiveType}`);
    if (typeof hardwareNavigator.connection?.downlink === 'number') link.push(`about ${hardwareNavigator.connection.downlink} Mb/s reported`);
    wifi.detail = `${link.join(' · ')}. Nearby WiFi scan results are still not exposed by any browser.`;
    wifi.status = 'limited';
  }

  const bluetooth = find(next, 'bluetooth');
  if (isMobile && bluetooth) {
    const available = Boolean(hardwareNavigator.bluetooth?.requestDevice);
    bluetooth.status = available ? 'permission' : 'unsupported';
    bluetooth.detail = available
      ? 'This browser may let you select one BLE device with permission. BackSpyne does not passively discover nearby advertisements from the phone browser.'
      : 'This mobile browser does not expose Web Bluetooth device selection.';
    bluetooth.use = 'User-approved BLE device selection only; use the local bridge for measured scans';
  }

  if (!isMobile && hardwareNavigator.usb?.getDevices) {
    try {
      const usbDevices = await hardwareNavigator.usb.getDevices();
      const usb = find(next, 'usb');
      if (usb) {
        usb.status = usbDevices.length ? 'connected' : 'permission';
        usb.detail = usbDevices.length
          ? `${usbDevices.length} previously approved USB device${usbDevices.length === 1 ? '' : 's'} available.`
          : 'USB is supported. Select an approved adapter to grant access.';
      }
    } catch {
      const usb = find(next, 'usb');
      if (usb) usb.status = 'permission';
    }
  }

  if (!isMobile && hardwareNavigator.serial?.getPorts) {
    try {
      const ports = await hardwareNavigator.serial.getPorts();
      const serial = find(next, 'serial');
      if (serial) {
        serial.status = ports.length ? 'connected' : 'permission';
        serial.detail = ports.length
          ? `${ports.length} previously approved serial port${ports.length === 1 ? '' : 's'} available.`
          : 'Serial is supported. Select an approved port to grant access.';
      }
    } catch {
      const serial = find(next, 'serial');
      if (serial) serial.status = 'permission';
    }
  }

  return next;
}

export type HardwareDecision = { status: HardwareStatus; detail: string };

/**
 * Asks the operating system for one capability, on the operator's instruction only, and
 * reports back what actually happened. Nothing is requested at page load, and a refused or
 * cancelled prompt is described as such rather than retried or hidden.
 */
export async function requestHardwareAccess(id: HardwareCapability['id']): Promise<HardwareDecision> {
  const hardwareNavigator = navigator as HardwareNavigator;
  try {
    if (id === 'bluetooth' && hardwareNavigator.bluetooth?.requestDevice) {
      const device = await hardwareNavigator.bluetooth.requestDevice({ acceptAllDevices: true });
      return { status: 'permission', detail: `${device.name ?? 'BLE peripheral'} selected and approved. Selection alone does not connect to it or scan advertisements; use a scanner bridge for measured observations.` };
    }
    if (id === 'usb' && hardwareNavigator.usb?.requestDevice) {
      await hardwareNavigator.usb.requestDevice({ filters: [] });
      return { status: 'connected', detail: 'Approved USB device selected. Connect it to a local sensor bridge to stream observations.' };
    }
    if (id === 'serial' && hardwareNavigator.serial?.requestPort) {
      await hardwareNavigator.serial.requestPort({ filters: [] });
      return { status: 'connected', detail: 'Approved serial port selected. A local Python bridge can stream observations through it.' };
    }
    if (id === 'camera-mic' && navigator.mediaDevices?.getUserMedia) {
      const media = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      media.getTracks().forEach(track => track.stop());
      return { status: 'connected', detail: 'Permission granted. BackSpyne does not retain camera or microphone data.' };
    }
    if (id === 'location' && navigator.geolocation) {
      await new Promise<void>((resolve, reject) => navigator.geolocation.getCurrentPosition(() => resolve(), reject, { enableHighAccuracy: false, maximumAge: 300000, timeout: 10000 }));
      return { status: 'connected', detail: 'Location permission granted. Coordinates remain local to this browser session.' };
    }
    const labels: Record<string, string> = {
      bluetooth: 'This browser or mobile operating system does not expose Bluetooth device selection.',
      usb: 'This browser or device does not expose USB device selection.',
      serial: 'This browser or device does not expose serial port selection.',
    };
    return { status: 'unsupported', detail: labels[id] ?? 'This browser does not expose that capability.' };
  } catch (error) {
    const cancelled = error instanceof DOMException && error.name === 'NotFoundError';
    return {
      status: 'limited',
      detail: cancelled ? 'No device was selected. No scan was started.' : 'Permission was denied or the device is unavailable. Check OS/browser permissions and try again.',
    };
  }
}
