// Downloading the desktop bridge from the site itself.
//
// The bridge has to run beside real radio adapters, which no browser page can do. What a page
// can do is hand over the exact folder that runs there, list what is inside it, and keep the
// archive on this origin so nobody has to find a repository and guess which directory to copy.
// The listing is shown before the download because a download you cannot inspect is a
// download you have to trust.

import { useEffect, useState } from 'react';
import { Download, FileArchive, RefreshCw, ShieldCheck } from 'lucide-react';

type BridgeManifest = {
  available: boolean;
  reason?: string;
  fileName?: string;
  bytes?: number;
  fileCount?: number;
  builtAt?: string;
  files?: Array<{ path: string; bytes: number }>;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function BridgeDownload({ testId = 'bridge-download' }: { testId?: string }) {
  const [manifest, setManifest] = useState<BridgeManifest | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const response = await fetch('/api/bridge/manifest', { credentials: 'include' });
        if (disposed) return;
        if (response.status === 401 || response.status === 503) {
          setError('Sign in to download the local bridge.');
          return;
        }
        if (!response.ok) {
          setError(`The download could not be prepared (${response.status}).`);
          return;
        }
        setManifest(await response.json() as BridgeManifest);
      } catch {
        if (!disposed) setError('The download could not be prepared; check your connection.');
      }
    })();
    return () => { disposed = true; };
  }, []);

  const available = manifest?.available === true;
  return <div className="bridge-download" data-testid={testId}>
    <div className="bridge-download-head">
      <span className="bridge-download-icon"><FileArchive aria-hidden="true" /></span>
      <div>
        <strong>Local bridge, one download</strong>
        <p>
          {available
            ? <>A single ZIP holding the whole scanner folder — {manifest?.fileCount} files, {formatBytes(manifest?.bytes ?? 0)}. Unzip it, paste your paired relay token into <code>.env</code>, and start it. It reads the WiFi and Bluetooth adapters on that machine, which is the one thing a browser cannot do.</>
            : error || 'The local bridge archive is being prepared.'}
        </p>
      </div>
      {available && <a className="btn btn-primary" href="/api/bridge/download" download data-testid="button-download-bridge"><Download size={13} aria-hidden="true" /> Download .zip</a>}
      {!available && !error && <RefreshCw className="spin" size={15} aria-hidden="true" />}
    </div>
    {available && manifest?.files?.length ? <details className="bridge-download-list">
      <summary>{manifest.fileCount} files inside · built {manifest.builtAt ? new Date(manifest.builtAt).toLocaleDateString() : 'recently'}</summary>
      <ul>{manifest.files.slice(0, 12).map((file) => <li key={file.path} className="mono">{file.path} <span>{formatBytes(file.bytes)}</span></li>)}</ul>
      {manifest.fileCount && manifest.fileCount > 12 ? <p className="mono">…and {manifest.fileCount - 12} more.</p> : null}
    </details> : null}
    {available && <p className="bridge-download-note"><ShieldCheck size={12} aria-hidden="true" /> The archive contains no credentials: the relay token is entered on the machine that runs it and never ships in a download.</p>}
  </div>;
}
