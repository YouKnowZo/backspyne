// Pages a visitor sees before signing in.
//
// The landing page's job is to answer "what do I get?" before asking for an account, so its
// hero is a miniature of the actual deliverable — drawn with the same paper, rules, and scale
// as the generated report — rather than a screenshot of the console.

import { ChevronRight, Radio, ShieldCheck } from 'lucide-react';
import { Show, SignIn, SignUp } from '@clerk/react';
import { Redirect } from 'wouter';

import { Brand } from '../components/console';
import { basePath } from '../lib/env';

/**
 * A miniature of the document the product produces, drawn with the same paper, rules, and
 * scale as the real report. The page's job is to answer "what do I get?" before the visitor
 * signs in, so the hero is the deliverable rather than a screenshot of the console.
 */
export function ReportSheetPreview() {
  const bars: Array<[string, number, string]> = [['Channel 1', 64, '2.4 GHz'], ['Channel 6', 41, '2.4 GHz'], ['Channel 44', 28, '5 GHz']];
  return <figure className="sheet-preview" aria-label="Preview of the generated client report">
    <div className="sheet-masthead"><span>BackSpyne</span><span>Wireless assessment · report</span></div>
    <div className="sheet-title">What this relay measured nearby, and what it does not mean.</div>
    <div className="sheet-stats"><div><b>118</b><span>WiFi access points</span></div><div><b>14</b><span>BLE advertisers</span></div><div><b>96</b><span>reported in the last minute</span></div></div>
    <div className="sheet-ruler"><span className="sheet-band" /><span className="sheet-median" />
      <em style={{ left: '8%' }}>−31</em><em style={{ left: '56%' }}>−66</em><em style={{ left: '92%' }}>−91</em>
    </div>
    <div className="sheet-bars">{bars.map(([label, value, band]) => <div className="sheet-bar-row" key={label}><span>{label}</span><span className="sheet-bar-track"><b style={{ width: `${value}%` }} /></span><em>{band}</em></div>)}</div>
    <div className="sheet-sections"><span>01 What was measured</span><span>02 Channel occupancy</span><span>03 Encryption posture</span><span>04 Who is transmitting</span><span>05 Received signal range</span><span>06 Findings</span><span>07 Method and limits</span></div>
    <figcaption className="sheet-caption">The assessment your client keeps: sectioned so it can be cited, printable to PDF, generated from the same measurement shown on screen.</figcaption>
  </figure>;
}

export function Landing() {
  const steps: Array<[string, string, string]> = [
    ['01', 'Pair a relay', 'One command on a machine that has the WiFi or Bluetooth adapter. The relay scans locally and reports signed measurements to your account.'],
    ['02', 'Measure the site', 'Channel occupancy, encryption posture, vendor inventory, and the range of received levels, with the limits of each method stated alongside it.'],
    ['03', 'Hand over the report', 'Generate a printable assessment that carries the findings, the method, and the statement of what these measurements cannot tell anyone.'],
  ];
  return <div className="landing-shell"><div className="landing-inner">
    <header className="landing-top"><Brand /><div className="landing-top-actions"><a className="btn" href={`${basePath}/sign-in`}>Sign in</a></div></header>
    <div className="landing-hero">
      <div className="landing-copy">
        <div className="page-kicker">BackSpyne by PaperBagExpress</div>
        <h1>Measure the air,<br />then hand over a document.</h1>
        <p>A relay you control scans nearby WiFi access points and Bluetooth advertisers and reports what it measured. BackSpyne turns that into a cited, printable site assessment: descriptive, sourced, and explicit about what it does not prove.</p>
        <div className="landing-actions"><a className="btn btn-primary" href={`${basePath}/sign-up`}>Create your first assessment <ChevronRight size={14} aria-hidden="true" /></a><a className="btn landing-secondary" href={`${basePath}/sign-in`}>Enter operator console</a></div>
        <div className="landing-proof"><span><ShieldCheck size={14} aria-hidden="true" /> Scanning runs on your hardware</span><span><Radio size={14} aria-hidden="true" /> Vendor data stays on the machine</span><span><ShieldCheck size={14} aria-hidden="true" /> No person tracking, by design</span></div>
      </div>
      <ReportSheetPreview />
    </div>
    <ol className="landing-steps">{steps.map(([number, title, detail]) => <li key={number}><span>{number}</span><h2>{title}</h2><p>{detail}</p></li>)}</ol>
    <div className="landing-footer"><span>Authorized environments only. Scan where you hold permission.</span><span>© PaperBagExpress · BackSpyne</span><a href="/legal" className="legal-link">Legal &amp; privacy</a></div>
  </div></div>;
}

export function SignInPage() {
  return <div className="auth-shell"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div>;
}

export function SignUpPage() {
  return <div className="auth-shell"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div>;
}

export function HomeRedirect() {
  return <><Show when="signed-in"><Redirect to="/user-portal" /></Show><Show when="signed-out"><Landing /></Show></>;
}

export function LegalPage() {
  return <main className="legal-page">
    <a href="/" className="legal-back">← BackSpyne home</a>
    <h1>Legal, privacy & acceptable use</h1>
    <p><strong>Important:</strong> This is general information, not legal advice or a substitute for jurisdiction-specific terms, privacy notices, or counsel review. It cannot guarantee protection from liability. Replace all bracketed items and have qualified counsel review before public operation.</p>
    <h2>Authorized use only</h2>
    <p>Use this software only on networks, radio equipment, locations, and data for which you have documented authority and any required consent. You are responsible for complying with wiretap, computer access, radio, privacy, consumer-protection, workplace-monitoring, and data-protection laws. No use to stalk, identify, track, surveil, or harm people; bypass device/network access controls; intercept communications; or conduct covert monitoring.</p>
    <h2>What the scanner can and cannot do</h2>
    <p>Standard operating-system APIs report nearby WiFi access points and BLE advertisements that are visible to the adapter. They do not enumerate every nearby WiFi client or Bluetooth device; identifiers may be randomized or absent. RSSI is noisy and does not establish distance, direction, identity, person presence, occupancy, movement, or health. Optional CSI research mode requires separate compatible hardware, an authenticated live sensing engine, and any required room calibration. Its outputs are experimental, not independently validated by this console, may be absent when the engine abstains, and are not for safety-critical, medical, identity, or emergency use. No named-person identification is supported.</p>
    <h2>Data and privacy</h2>
    <p>When configured, the local bridge sends WiFi/BLE observation identifiers and radio metadata, node identifiers, timestamps, and measured aggregates to the configured API. The server stores account-scoped telemetry in its configured database and streams it to signed-in users. Do not scan or transmit personal data unless you have a lawful basis and any required notice/consent. The operator must document purposes, legal basis, retention/deletion schedule, processors, contact details, rights-request process, and security practices before deployment. Authentication, hosting, and database providers may process account/network metadata under their own terms.</p>
    <h2>Security and availability</h2>
    <p>Use HTTPS and strong, unique server-side credentials. Never place server secrets in frontend variables or commit them. The local node token is a shared credential and must be rotated if exposed. The software is provided as-is; measurements, access, persistence, alerts, and service availability are not guaranteed. It is not for emergency response, safety-critical, medical, law-enforcement, or evidentiary use.</p>
    <h2>Operator contact and policy links</h2>
    <p>Operator/business name: [operator must supply]. Contact: [operator must supply]. Effective date: [operator must supply]. Replace these placeholders with actual policy URLs and business/contact details before public use. Do not collect telemetry until retention and deletion policies are published and configured.</p>
  </main>;
}

export function AuthNotConfigured() {
  return <main className="legal-page">
    <a href="/" className="legal-back">← BackSpyne home</a>
    <h1>Operator sign-in is not configured</h1>
    <p>This deployment does not have authentication credentials set. No account data is being collected, stored, or transmitted. Set <code>VITE_CLERK_PUBLISHABLE_KEY</code> (build) and <code>CLERK_SECRET_KEY</code> / <code>CLERK_PUBLISHABLE_KEY</code> (server) to enable the operator portal.</p>
    <p><a href="/legal" className="legal-link">Read the legal, privacy &amp; acceptable-use notice</a></p>
  </main>;
}
