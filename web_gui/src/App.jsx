import { useState, useEffect, useRef } from 'react'
import './App.css'

function App() {
  const [nodesData, setNodesData] = useState({});
  const [nodes, setNodes] = useState([window.location.hostname]);
  const [newNodeIp, setNewNodeIp] = useState('');
  
  const pingSynth = useRef(null);
  
  const [trackedTarget, setTrackedTarget] = useState(null);
  const [showHowTo, setShowHowTo] = useState(false);

  useEffect(() => {
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
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(400 + (intensity * 4), context.currentTime); 
    
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

  useEffect(() => {
    if (trackedTarget && aggregatedDevices[trackedTarget]) {
      const d = aggregatedDevices[trackedTarget];
      let normalized = d.type === 'Wi-Fi' ? d.rssi : Math.max(0, Math.min(100, (d.rssi + 100) * (100/70)));
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
    link.setAttribute("download", "BackSpyne_DeepTrace_Log.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getProximityColor = (percentage) => {
    if (percentage > 80) return '#ef4444'; 
    if (percentage > 50) return '#f59e0b'; 
    if (percentage > 20) return '#3b82f6'; 
    return '#64748b'; 
  };

  // Security parsing for specialized hardware mapping
  const isRandomizedMac = (mac) => {
    if (!mac || mac.length < 5) return false;
    const char = mac.charAt(1).toUpperCase();
    return ['2', '6', 'A', 'E'].includes(char);
  };

  // Tracking Mode Render
  if (trackedTarget && aggregatedDevices[trackedTarget]) {
    const d = aggregatedDevices[trackedTarget];
    let normalized = d.type === 'Wi-Fi' ? d.rssi : Math.max(0, Math.min(100, (d.rssi + 100) * (100/70)));
    const pxColor = getProximityColor(normalized);
    const isRandMAC = isRandomizedMac(d.address);
    const unknownVendor = d.vendor === 'Unknown Manufacturer';

    return (
      <div className="app-container tracking-mode">
        <button className="back-btn" onClick={() => setTrackedTarget(null)}>← Abort Tracking</button>
        <div className="focus-radar" style={{ '--prox-color': pxColor, '--anim-speed': d.active ? `${1.5 - (normalized/100)}s` : '5s' }}>
          <div className="radar-circle rc-1"></div>
          <div className="radar-circle rc-2"></div>
          <div className="radar-circle rc-3"></div>
          <div className="target-core" style={{boxShadow: `0 0 40px ${pxColor}`}}>{normalized.toFixed(0)}%</div>
        </div>
        
        <div className="target-intel glassmorphism">
          <div className="intel-header">
            <h2>Target Intelligence File</h2>
            <div className={`status-badge ${d.active ? 'active-badge' : 'ghost-badge'}`}>
              {d.active ? 'LIVE EMISSION' : 'GHOST SIGNAL'}
            </div>
          </div>
          <div className="intel-grid">
            <div className="intel-block">
              <label>Device Type</label>
              <strong>{d.type} Node</strong>
            </div>
            <div className="intel-block">
              <label>Broadcasting Alias</label>
              <strong>{d.name || 'HIDDEN / UNKNOWN'}</strong>
            </div>
            <div className="intel-block">
              <label>Hardware MAC Signature</label>
              <strong style={{fontFamily: 'monospace'}}>{d.address}</strong>
            </div>
            <div className="intel-block">
              <label>Manufacturer Decode</label>
              <span className={`vendor-tag ${unknownVendor ? 'unknown-tag' : ''}`}>{d.vendor || 'Unknown'}</span>
            </div>
          </div>

          <div className="intel-analysis">
            <h3>Automated Hardware Analysis</h3>
            <p>
              {isRandMAC 
                ? "⚠️ SECURITY NOTE: This device is using MAC Address Randomization to hide its true manufacturer identity. This is commonly used by modern iOS and Android devices for anti-tracking." 
                : "✅ STANDARD MAC: This device is broadcasting its true hardware identity card."}
            </p>
            {unknownVendor && !isRandMAC && (
              <div className="deep-trace-action">
                <p>The local database could not immediately resolve this hardware vendor. Execute a Deep Trace database search to extract potential device origins.</p>
                <a 
                  href={`https://maclookup.app/search/result?mac=${d.address}`} 
                  target="_blank" 
                  rel="noreferrer" 
                  className="btn trace-btn"
                >
                  DEEP TRACE MAC ONLINE 🔍
                </a>
              </div>
            )}
          </div>

          <div className="mesh-block">
            <h3>Mesh Detection Intercepts</h3>
            <ul>
              {d.detections.map((det, i) => (
                <li key={i}>Node [ {det.node} ] intercepted signal at {det.signal}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {showHowTo && (
        <div className="modal-overlay" onClick={() => setShowHowTo(false)}>
          <div className="modal-content glassmorphism" onClick={e => e.stopPropagation()}>
            <h2>BackSpyne Field Manual</h2>
            <p className="creator-tag">Created exclusively by <strong>paperbagexpress</strong></p>
            <div className="modal-scroll-area">
              <h3>System Overview</h3>
              <p>BackSpyne is an advanced military-inspired tracking system designed to identify hidden hardware, cameras, electronics, and intercept signals via specialized Node networking.</p>
              
              <h3>Usage Directives</h3>
              <ul>
                <li><strong>Sonar Audio:</strong> Enables an audible beep pinging directly proportional to your physical proximity to a tracked device.</li>
                <li><strong>Tracking Mode:</strong> Tap any target grid item to lock your radar. If a tracker disappears, it falls into "Ghost Status", allowing you to permanently track what scanned you previously.</li>
                <li><strong>Mesh Triangulation:</strong> Use multiple computers around your compound running the BackSpyne engine. Add their local IPs in the "Networked Nodes" section to aggressively pinpoint origins.</li>
                <li><strong>Deep Traces:</strong> If an unknown Manufacturer appears, open its Intelligence profile to manually execute an external Deep Trace to force-find the component producer.</li>
              </ul>
            </div>
            <button className="btn close-modal" onClick={() => setShowHowTo(false)}>CLOSE MANUAL</button>
          </div>
        </div>
      )}

      <header className="header glassmorphism">
        <div className="header-top">
          <div className="radar-icon">
            <div className="radar-wave"></div>
          </div>
          <div className="header-titles">
            <h1>BACKSPYNE</h1>
            <p>Advanced Real-Time Signal Triangulation Framework</p>
          </div>
        </div>
        
        <div className="action-buttons">
          <button className="btn activate" onClick={() => {
            if(pingSynth.current && pingSynth.current.state === 'suspended') {
               pingSynth.current.resume();
            }
          }}>Enable Sonar Audio</button>
          <button className="btn outline" onClick={() => setShowHowTo(true)}>Field Manual (How to Use)</button>
          <button className="btn download" onClick={downloadCSV}>Export DeepTrace CSV</button>
        </div>
      </header>

      <main className="content">
        <section className="sensor-panel full-panel glassmorphism">
          <div className="panel-header">
            <h2>Radar Targets Discovered</h2>
            <span className="target-count">{sortedDevices.length} TRACED</span>
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
                     <div className="vendor-wrap">
                       <span className="device-vendor">{d.vendor || 'Unknown Manufacturer'}</span>
                       {isRandomizedMac(d.address) && <span className="rand-tag" title="Randomized MAC">Secured</span>}
                     </div>
                     {!d.active && <span className="device-ghosting">GHOSTED</span>}
                   </div>
                   <div className="target-strength">
                     <span className="target-percent" style={{color: pxColor}}>{normalized.toFixed(0)}%</span>
                     <span className="target-raw">{d.signal}</span>
                   </div>
                </div>
              );
            })}
            {sortedDevices.length === 0 && <p className="empty-state">System scanning... No targets in sector.</p>}
          </div>
        </section>

        <section className="nodes-panel glassmorphism">
          <div className="panel-header">
            <h2>Active Networked Nodes</h2>
          </div>
          <div className="nodes-list">
             {nodes.map(ip => {
               const data = nodesData[ip];
               if (!data) return <div key={ip} className="node-item loading">Tracer [ {ip} ] Establishing comms...</div>;
               const specs = data.node_specs;
               return (
                 <div key={ip} className="node-item active">
                   <div className="node-header">
                     <span className="node-hostname">{specs.hostname}</span>
                     <span className="node-ip">{ip === window.location.hostname ? 'Local Node' : ip}</span>
                   </div>
                 </div>
               )
             })}
          </div>
          <form className="add-node-form" onSubmit={addNode}>
            <input 
              type="text" 
              placeholder="Inject Remote Node IP (e.g. 192.168.1.100)" 
              value={newNodeIp} 
              onChange={(e) => setNewNodeIp(e.target.value)}
            />
            <button type="submit">Deploy Mesh</button>
          </form>
        </section>
      </main>

      <footer className="footer glassmorphism">
        <p><strong>BackSpyne Track & Trace Utility</strong> exclusively engineered and produced by <strong>paperbagexpress</strong></p>
        <div className="footer-links">
          <a href="https://github.com/YouKnowZo/backspyne" target="_blank" rel="noreferrer">GitHub Repository</a>
          <span className="divider">|</span>
          <span className="disclaimer"><strong>DISCLAIMER:</strong> Defensive counter-surveillance and educational utility only. Ensure property authorizations before large-range scanning. The creator is not liable for unauthorized network tracing.</span>
        </div>
      </footer>
    </div>
  )
}

export default App
