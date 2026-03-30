import { useState, useEffect } from 'react'
import './App.css'

function App() {
  const [nodesData, setNodesData] = useState({});
  const [nodes, setNodes] = useState([window.location.hostname]); // Start with self
  const [newNodeIp, setNewNodeIp] = useState('');
  
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

  // Combine and aggregate signals from all nodes
  const aggregatedWifi = {};
  const aggregatedBluetooth = {};

  Object.entries(nodesData).forEach(([ip, nodeInfo]) => {
    if (!nodeInfo || !nodeInfo.scan_data) return;
    const hostname = nodeInfo.node_specs.hostname;

    // Aggregate Wi-Fi
    nodeInfo.scan_data.wifi.forEach(device => {
      const mac = device.address;
      if (!aggregatedWifi[mac]) {
        aggregatedWifi[mac] = { ...device, detections: [] };
      }
      aggregatedWifi[mac].detections.push({ node: hostname || ip, rssi: device.rssi, signal: device.signal });
      if (device.rssi > aggregatedWifi[mac].rssi) {
        aggregatedWifi[mac].rssi = device.rssi; // taking the strongest signal
      }
    });

    // Aggregate Bluetooth
    nodeInfo.scan_data.bluetooth.forEach(device => {
      const mac = device.address;
      if (!aggregatedBluetooth[mac]) {
        aggregatedBluetooth[mac] = { ...device, detections: [] };
      }
      aggregatedBluetooth[mac].detections.push({ node: hostname || ip, rssi: device.rssi, signal: device.signal });
      if (device.rssi > aggregatedBluetooth[mac].rssi) {
        aggregatedBluetooth[mac].rssi = device.rssi; // taking strongest signal
      }
    });
  });

  const sortedWifi = Object.values(aggregatedWifi).sort((a,b) => b.rssi - a.rssi);
  const sortedBT = Object.values(aggregatedBluetooth).sort((a,b) => b.rssi - a.rssi);

  return (
    <div className="app-container">
      <header className="header glassmorphism">
        <div className="radar-icon">
          <div className="radar-wave"></div>
        </div>
        <h1>Distributed Mesh Tracker</h1>
        <p>Combining Scanner Nodes for Enhanced Signal Detection</p>
      </header>

      <section className="nodes-panel glassmorphism">
        <h2>Active Scanner Nodes (Resources)</h2>
        <div className="nodes-list">
           {nodes.map(ip => {
             const data = nodesData[ip];
             if (!data) return <div key={ip} className="node-item loading">Connecting to {ip}...</div>;
             const specs = data.node_specs;
             return (
               <div key={ip} className="node-item active">
                 <div className="node-header">
                   <span className="node-hostname">{specs.hostname}</span>
                   <span className="node-ip">{ip === window.location.hostname ? 'Local Node' : ip}</span>
                 </div>
                 <div className="node-specs">
                   <span>OS: {specs.os}</span>
                   <span>CPU: {specs.cpu_cores} Cores ({specs.cpu_usage_percent}%)</span>
                   <span>RAM: {specs.ram_usage_percent}% of {specs.ram_total_gb}GB</span>
                 </div>
               </div>
             )
           })}
        </div>
        <form className="add-node-form" onSubmit={addNode}>
          <input 
            type="text" 
            placeholder="Add Node IP Address (e.g., 192.168.1.5)" 
            value={newNodeIp} 
            onChange={(e) => setNewNodeIp(e.target.value)}
          />
          <button type="submit">Combine Node</button>
        </form>
      </section>

      <main className="content">
        <section className="sensor-panel glassmorphism">
          <h2>Aggregated Wi-Fi</h2>
          <div className="device-list">
            {sortedWifi.map(d => (
              <div className="device-item" key={`wifi-${d.address}`}>
                 <div className="device-info">
                   <span className="device-name">{d.name}</span>
                   <span className="device-mac">{d.address}</span>
                   <div className="detections">
                     Seen by: {d.detections.map(det => `${det.node} (${det.signal})`).join(', ')}
                   </div>
                 </div>
                 <div className="signal-strength">
                   <div className="signal-bar-fill" style={{ width: `${d.rssi}%` }}></div>
                   <span className="signal-text">Max: {d.rssi}%</span>
                 </div>
              </div>
            ))}
            {sortedWifi.length === 0 && <p className="empty-state">No Wi-Fi signals found</p>}
          </div>
        </section>

        <section className="sensor-panel glassmorphism">
          <h2>Aggregated Bluetooth LE</h2>
          <div className="device-list">
            {sortedBT.map(d => {
              const normalized = Math.max(0, Math.min(100, (d.rssi + 100) * (100/70)));
              return (
                <div className="device-item" key={`bt-${d.address}`}>
                   <div className="device-info">
                     <span className="device-name">{d.name}</span>
                     <span className="device-mac">{d.address}</span>
                     <div className="detections bt-text">
                       Seen by: {d.detections.map(det => `${det.node} (${det.signal})`).join(', ')}
                     </div>
                   </div>
                   <div className="signal-strength">
                     <div className="signal-bar-fill bt-fill" style={{ width: `${normalized}%` }}></div>
                     <span className="signal-text">Max: {d.rssi} dBm</span>
                   </div>
                </div>
              );
            })}
            {sortedBT.length === 0 && <p className="empty-state">No Bluetooth signals found</p>}
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
