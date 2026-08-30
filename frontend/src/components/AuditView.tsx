import { useCallback, useEffect, useState } from "react";
import { auditTypeLabel, displayName, localizedText, verdictLabel } from "../lib/presentation";

import { getApiBase } from "../config";
const API_BASE = getApiBase();
type AuditEvent = { event_id: string; timestamp: string; type: string; mandate_id: string; verdict?: "APPROVE" | "ESCALATE" | "REJECT"; summary: string };

function formatDate(timestamp: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(timestamp));
}

export default function AuditView() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadAudit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/audit`);
      if (!response.ok) throw new Error("Couldn't load the full audit trail.");
      setEvents(await response.json() as AuditEvent[]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No connection to the system.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadAudit(); }, [loadAudit]);
  const verdictCounts = events.reduce((counts, event) => {
    if (event.verdict === "APPROVE") counts.approve += 1;
    if (event.verdict === "ESCALATE") counts.escalate += 1;
    if (event.verdict === "REJECT") counts.reject += 1;
    return counts;
  }, { approve: 0, escalate: 0, reject: 0 });
  return (
    <main className="reading-shell">
      <section className="reading-page">
        <header className="reading-header"><div><p className="mission-kicker">AUDIT / APPEND-ONLY TRAIL</p><h1>Complete system record</h1><p>The verifiable history of every mandate, decision, and outcome.</p></div><button className="refresh-button" onClick={() => void loadAudit()} disabled={loading} type="button">{loading ? "REFRESHING…" : "↻ REFRESH"}</button></header>
        {error && <div className="connection-error" role="alert"><strong>No connection to the system.</strong> {error}</div>}
        <div className="verdict-summary" aria-label="Trail verdict summary"><span className="summary-approve">{verdictCounts.approve} approved</span><span className="summary-escalate">{verdictCounts.escalate} need approval</span><span className="summary-reject">{verdictCounts.reject} rejected</span></div>
        <section className="audit-panel"><div className="panel-title"><span>EVENTS · NEWEST FIRST</span><small>{events.length} RECORDS</small></div>
          {loading ? <p className="empty-copy">Querying the audit trail…</p> : events.length ? <div className="audit-table-wrap"><table className="audit-table"><thead><tr><th>Date & time</th><th>Type</th><th>Mandate</th><th>Verdict</th><th>Summary</th></tr></thead><tbody>{events.map((event) => <tr className={`audit-row-${event.verdict?.toLowerCase() ?? "neutral"}`} key={event.event_id}><td>{formatDate(event.timestamp)}</td><td><span className="event-type">{auditTypeLabel(event.type)}</span></td><td><code>{displayName(event.mandate_id)}</code></td><td>{event.verdict ? <span className={`verdict-tag verdict-${event.verdict.toLowerCase()}`}>{verdictLabel(event.verdict)}</span> : <span className="neutral-tag">—</span>}</td><td>{localizedText(event.summary)}</td></tr>)}</tbody></table></div> : <p className="empty-copy">No activity yet — run Saturday to get started.</p>}
        </section>
      </section>
    </main>
  );
}
