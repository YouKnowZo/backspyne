// Handing the assessment to the client.
//
// The report button opens the operator's own copy, which requires a session. A client has
// none, so this control asks the server for a signed link scoped to this account. Copying it
// is a convenience, not the point: if the browser refuses clipboard access the link is still
// shown, selectable, because an operator who has just been told a link exists must never be
// left without it.

import { useRef, useState } from 'react';
import { Link2, Check, RefreshCw } from 'lucide-react';

import { createReportShareLink } from '../lib/reports';

export function ShareReportLink({ siteLabel, operatorName }: { siteLabel: string; operatorName: string }) {
  const [state, setState] = useState<'idle' | 'working' | 'copied' | 'manual' | 'failed'>('idle');
  const [message, setMessage] = useState('');
  const [url, setUrl] = useState('');
  const field = useRef<HTMLInputElement>(null);

  const share = async () => {
    setState('working');
    setMessage('');
    setUrl('');
    let link: Awaited<ReturnType<typeof createReportShareLink>>;
    try {
      link = await createReportShareLink(siteLabel, operatorName);
    } catch (error) {
      setState('failed');
      setMessage(error instanceof Error && error.message
        ? `${error.message} The operator copy above still works.`
        : 'The share link could not be created. The operator copy above still works.');
      return;
    }
    setUrl(link.url);
    try {
      await navigator.clipboard.writeText(link.url);
      setState('copied');
      setMessage(`Link copied. It opens this assessment without a sign-in and stops working in ${link.days} days.`);
    } catch {
      setState('manual');
      setMessage(`This browser blocked the clipboard, so the link is shown below instead. It opens this assessment without a sign-in and stops working in ${link.days} days.`);
      window.setTimeout(() => field.current?.select(), 0);
    }
  };

  return <div className="share-report">
    <button
      type="button"
      className="btn"
      data-testid="button-share-client-report"
      disabled={state === 'working'}
      onClick={() => void share()}
    >
      {state === 'working'
        ? <><RefreshCw className="spin" size={13} aria-hidden="true" /> Creating link</>
        : state === 'copied'
          ? <><Check size={13} aria-hidden="true" /> Client link copied</>
          : <><Link2 size={13} aria-hidden="true" /> Copy client link</>}
    </button>
    {(state === 'manual' || (state === 'copied' && url)) && (
      <input
        ref={field}
        className="share-report-url"
        data-testid="input-share-client-report"
        readOnly
        value={url}
        aria-label="Client assessment link"
        onFocus={event => event.currentTarget.select()}
      />
    )}
    <p className="share-report-status" role="status" aria-live="polite">
      {message || 'A client link opens this same document without an account, for the number of days the server signs into it.'}
    </p>
  </div>;
}
