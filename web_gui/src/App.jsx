import { useState, useEffect, useRef } from 'react'
import './App.css'

function App() {
  const [nodesData, setNodesData] = useState({});
  const [nodes, setNodes] = useState([window.location.hostname]);
  const [newNodeIp, setNewNodeIp] = useState('');
  
  // Audio contexts
  const pingSynth = useRef(null);
  
  // Tracking Mode State
  const [trackedTarget, setTrackedTarget] = useState(null);

  useEffect(() => {
    // Basic setup for a sonar ping effect using WebAudio API
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      pingSynth.current = new AudioContext();
    }
  }, []);

  const playSonarPing = (intensity) => {
    if (!pingSynth.current || pingSynth.current.state === 'suspended') return;
    
    const context = pingSynth.current;
    const osc = context.createOscillator();
    const gainNode = context.createGain();
    
    // Closer target = higher pitch
    osc.type = 'sine';
    osc.frequency.setValueAtTime(400 + (intensity * 4), context.currentTime); 
    
    // Closer target = louder and faster attack
    gainNode.gain.setValueAtTime(0, context.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.5, context.currentTime + 0.05);
    gainNode.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.5);
    
    osc.connect(gainNode);
    gainNode.connect(context.destination);
    osc.start();
    osc.stop(context.currentTime + 0.5);
  };

  useEffect(() => {
    const fetchAllNodes = async () => {
      for (const ip of nodes) {
        try {
          const host = ip || 'localhost';
          const res = await fetch(`http://${host}:8000/api/scan`);
          const json = await res.json();
          setNodesData(prev => ({...prev, [ip]: json}));
        } catch (err) {
          console.error(`Node ${ip} fetch error:`, err);
        }
      }
    };
    
    fetchAllNodes();
    const intv = setInterval(fetchAllNodes, 2000);
    return () => clearInterval(intv);
  }, [nodes]);

  const addNode = (e) => {
    e.preventDefault();
    if (newNodeIp && !nodes.includes(newNodeIp)) {
      setNodes([...nodes, newNodeIp]);
      setNewNodeIp('');
    }
  };

  const aggregatedDevices = {};

  Object.entries(nodesData).forEach(([ip, nodeInfo]) => {
    if (!nodeInfo || !nodeInfo.scan_data) return;
    const hostname = nodeInfo.node_specs.hostname;

    const processDeviceBatch = (deviceDict, networkType) => {
      Object.entries(deviceDict).forEach(([mac, device]) => {
        if (!aggregatedDevices[mac]) {
          aggregatedDevices[mac] = { ...device, type: networkType, detections: [] };
        }
        aggregatedDevices[mac].detections.push({ 
          node: hostname || ip, 
          rssi: device.rssi, 
          signal: device.signal,
          active: device.active,
          last_seen: device.last_seen 
        });
        
        // Take strongest signal
        if (device.rssi > aggregatedDevices[mac].rssi) {
          aggregatedDevices[mac].rssi = device.rssi;
          aggregatedDevices[mac].active = device.active;
          aggregatedDevices[mac].last_seen = device.last_seen;
        }
      });
    };

    processDeviceBatch(nodeInfo.scan_data.wifi, 'Wi-Fi');
    processDeviceBatch(nodeInfo.scan_data.bluetooth, 'Bluetooth');
  });

  const sortedDevices = Object.values(aggregatedDevices).sort((a,b) => b.rssi - a.rssi);

  // If we are tracking a target, ping and update dynamically
  useEffect(() => {
    if (trackedTarget && aggregatedDevices[trackedTarget]) {
      const d = aggregatedDevices[trackedTarget];
      // Normalize RSSI roughly to 0-100%
      let normalized = 0;
      if (d.type === 'Wi-Fi') normalized = d.rssi;
      else normalized = Math.max(0, Math.min(100, (d.rssi + 100) * (100/70)));
      
      if (d.active) playSonarPing(normalized);
    }
  }, [nodesData, trackedTarget]);

  const downloadCSV = () => {
    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "MAC Address,Type,Name,Vendor,Signal Strength,Proximity %,Status\n";
    
    sortedDevices.forEach(d => {
      let normalized = d.type === 'Wi-Fi' ? d.rssi : Math.max(0, Math.min(100, (d.rssi + 100) * (100/70)));
      let row = `"${d.address}","${d.type}","${d.name}","${d.vendor}","${d.signal}","${normalized.toFixed(1)}%","${d.active ? 'Active' : 'Offline'}"`;
      csvContent += row + "\n";
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "BackSpyne_Signal_Log.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getProximityColor = (percentage) => {
    if (percentage > 80) return '#ef4444'; // Red (Hot / Very Close)
    if (percentage > 50) return '#f59e0b'; // Yellow (Warm)
    if (percentage > 20) return '#3b82f6'; // Blue (Cold)
    return '#64748b'; // Gray (Very Far)
  };

  // Render Target Tracking View
  if (trackedTarget && aggregatedDevices[trackedTarget]) {
    const d = aggregatedDevices[trackedTarget];
    let normalized = d.type === 'Wi-Fi' ? d.rssi : Math.max(0, Math.min(100, (d.rssi + 100) * (100/70)));
    const pxColor = getProximityColor(normalized);

    return (
      <div className="app-container tracking-mode">
        <button className="back-btn" onClick={() => setTrackedTarget(null)}>← Return to Radar</button>
        <div className="focus-radar" style={{ '--prox-color': pxColor, '--anim-speed': d.active ? `${1.5 - (normalized/100)}s` : '5s' }}>
          <div className="radar-circle rc-1"></div>
          <div className="radar-circle rc-2"></div>
          <div className="radar-circle rc-3"></div>
          <div className="target-core" style={{boxShadow: `0 0 40px ${pxColor}`}}>{normalized.toFixed(0)}%</div>
        </div>
        
        <div className="target-intel glassmorphism">
          <h2>Target Intelligence File</h2>
          <p><strong>Device Type:</strong> {d.type}</p>
          <p><strong>Alias/SSID:</strong> {d.name}</p>
          <p><strong>Hardware MAC:</strong> {d.address}</p>
          <p><strong>Manufacturer:</strong> <span className="vendor-tag">{d.vendor || 'Unknown'}</span></p>
          <p><strong>Live Status:</strong> {d.active ? <span style={{color: '#4ade80'}}>Active emitting</span> : <span style={{color: '#ef4444'}}>Offline / Ghost</span>}</p>
          <p><strong>Mesh Detections:</strong></p>
          <ul>
            {d.detections.map((det, i) => (
              <li key={i}>{det.node} observing at {det.signal} {det.active ? '⚡' : '💤'}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="header glassmorphism">
        <div className="radar-icon">
          <div className="radar-wave"></div>
        </div>
        <h1>BackSpyne Tracker</h1>
        <p>Live Distributed Signal Triangulation System</p>
        <div className="action-buttons">
          <button className="btn activate" onClick={() => {
            if(pingSynth.current && pingSynth.current.state === 'suspended') {
               pingSynth.current.resume();
            }
          }}>Enable Sonar Audio</button>
          <button className="btn download" onClick={downloadCSV}>Export CSV Report</button>
        </div>
      </header>

      <main className="content">
        <section className="sensor-panel full-panel glassmorphism">
          <div className="panel-header">
            <h2>Radar Targets Discovered</h2>
            <span className="target-count">{sortedDevices.length} Traced</span>
          </div>
          <div className="device-list grid-list">
            {sortedDevices.map(d => {
              let normalized = d.type === 'Wi-Fi' ? d.rssi : Math.max(0, Math.min(100, (d.rssi + 100) * (100/70)));
              const pxColor = getProximityColor(normalized);

              return (
                <div 
                  className={`device-target ${!d.active ? 'ghost-target' : ''}`} 
                  key={`${d.type}-${d.address}`}
                  onClick={() => setTrackedTarget(d.address)}
                >
                   <div className="target-prox-indicator" style={{backgroundColor: pxColor}}></div>
                   <div className="device-info">
                     <span className="device-name">{d.name} {d.type === 'Bluetooth' ? '📱' : '📡'}</span>
                     <span className="device-mac">{d.address}</span>
                     <span className="device-vendor">{d.vendor || 'Unknown Manufacturer'}</span>
                     {!d.active && <span className="device-ghosting">Target Lost</span>}
                   </div>
                   <div className="target-strength">
                     <span className="target-percent" style={{color: pxColor}}>{normalized.toFixed(0)}%</span>
                     <span className="target-raw">{d.signal}</span>
                   </div>
                </div>
              );
            })}
            {sortedDevices.length === 0 && <p className="empty-state">No targets detected in vicinity...</p>}
          </div>
        </section>

        <section className="nodes-panel glassmorphism">
          <h2>Networked Nodes</h2>
          <div className="nodes-list">
             {nodes.map(ip => {
               const data = nodesData[ip];
               if (!data) return <div key={ip} className="node-item loading">Tracer {ip} Pending...</div>;
               const specs = data.node_specs;
               return (
                 <div key={ip} className="node-item active">
                   <div className="node-header">
                     <span className="node-hostname">{specs.hostname}</span>
                     <span className="node-ip">{ip === window.location.hostname ? 'Local' : ip}</span>
                   </div>
                 </div>
               )
             })}
          </div>
          <form className="add-node-form" onSubmit={addNode}>
            <input 
              type="text" 
              placeholder="Inject Node IP" 
              value={newNodeIp} 
              onChange={(e) => setNewNodeIp(e.target.value)}
            />
            <button type="submit">Combine Node</button>
          </form>
        </section>
      </main>
    </div>
  )
}

export default App
