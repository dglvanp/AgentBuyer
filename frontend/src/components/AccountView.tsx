import { useCallback, useEffect, useState } from "react";
import { auditTypeLabel, localizedText, verdictLabel } from "../lib/presentation";

import { getApiBase } from "../config";
const API_BASE = getApiBase();

type AuditEvent = {
  event_id: string; timestamp: string; type: string; mandate_id: string;
  attempt_id?: string; verdict?: "APPROVE" | "ESCALATE" | "REJECT"; summary: string;
};
type MandateRecord = {
  live_state: { status: string; uses_count: number; amount_spent: number };
  mandate: { human?: { id?: string; display_name?: string }; constraints?: { max_uses?: number; currency?: string } };
};
type DisputeClaim = {
  dispute_id: string; attempt_id: string; verdict?: string;
  liable_party?: "HUMAN" | "MERCHANT" | "FRAUDSTER" | "AGENT";
  refund_issued: boolean; explanation?: string;
};

function formatDate(timestamp: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

function amount(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
}

// Traduce el veredicto forense del árbitro a lenguaje para el titular.
function liableCopy(party?: string): { label: string; tone: "human" | "protected" } {
  switch (party) {
    case "MERCHANT": return { label: "Merchant liable", tone: "protected" };
    case "FRAUDSTER": return { label: "Fraud — cardholder protected", tone: "protected" };
    case "AGENT": return { label: "Agent liable", tone: "protected" };
    default: return { label: "Valid charge — cardholder liable", tone: "human" };
  }
}

// Un cargo disputable es una compra que efectivamente ocurrió.
function isDisputable(event: AuditEvent): boolean {
  return Boolean(
    event.attempt_id &&
    (event.verdict === "APPROVE" || event.type === "purchase_completed" || event.type === "human_override_approved"),
  );
}

export default function AccountView({ mandateId }: { mandateId: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [mandate, setMandate] = useState<MandateRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [disputingId, setDisputingId] = useState<string | null>(null);
  const [dispute, setDispute] = useState<DisputeClaim | null>(null);
  const [disputeError, setDisputeError] = useState<string | null>(null);

  const loadAccount = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [trailResponse, mandateResponse] = await Promise.all([
        fetch(`${API_BASE}/audit/${mandateId}`),
        fetch(`${API_BASE}/mandates/${mandateId}`),
      ]);
      if (!trailResponse.ok || !mandateResponse.ok) throw new Error("Couldn't refresh your information.");
      setEvents(await trailResponse.json() as AuditEvent[]);
      setMandate(await mandateResponse.json() as MandateRecord);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No connection to the system.");
    } finally {
      setLoading(false);
    }
  }, [mandateId]);

  useEffect(() => { void loadAccount(); }, [loadAccount]);

  async function fileDispute(attemptId: string) {
    setDisputingId(attemptId);
    setDisputeError(null);
    setDispute(null);
    try {
      const claimantId = mandate?.mandate.human?.id ?? "hum_cardholder";
      const response = await fetch(`${API_BASE}/disputes/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attempt_id: attemptId,
          mandate_id: mandateId,
          claimant_id: claimantId,
          reason: "I don't recognize this charge — the cardholder denies authorizing it.",
        }),
      });
      if (!response.ok) {
        let message = `The system responded ${response.status}.`;
        try { const body = await response.json() as { detail?: string }; if (body.detail) message = body.detail; } catch { /* no-json */ }
        throw new Error(message);
      }
      setDispute(await response.json() as DisputeClaim);
      // El árbitro deja un evento en el trail; refrescamos para que se vea.
      void loadAccount();
    } catch (caught) {
      setDisputeError(caught instanceof Error ? caught.message : "Couldn't file the dispute.");
    } finally {
      setDisputingId(null);
    }
  }

  const status = mandate?.live_state.status === "active" ? "ACTIVE" : mandate?.live_state.status === "revoked" ? "REVOKED" : "LOADING";
  const verdictCounts = events.reduce((counts, event) => {
    if (event.verdict === "APPROVE") counts.approve += 1;
    if (event.verdict === "ESCALATE") counts.escalate += 1;
    if (event.verdict === "REJECT") counts.reject += 1;
    return counts;
  }, { approve: 0, escalate: 0, reject: 0 });

  const liable = liableCopy(dispute?.liable_party);

  return (
    <main className="reading-shell">
      <section className="reading-page">
        <header className="reading-header"><div><p className="mission-kicker">MY ACCOUNT / YOUR HISTORY</p><h1>What Saturday bought for you</h1><p>Review every decision made within your permission, at your own pace.</p></div><button className="refresh-button" onClick={() => void loadAccount()} disabled={loading} type="button">{loading ? "REFRESHING…" : "↻ REFRESH"}</button></header>
        {error && <div className="connection-error" role="alert"><strong>No connection to the system.</strong> {error}</div>}

        {/* Veredicto de la disputa: el trail auditable resuelve quién tiene razón. */}
        {dispute && (
          <div className={`dispute-card dispute-${liable.tone}`} role="status">
            <div className="dispute-card-head">
              <span className="dispute-eyebrow">DISPUTE RESOLUTION · {dispute.dispute_id}</span>
              <button className="dispute-close" onClick={() => setDispute(null)} type="button" aria-label="Close">✕</button>
            </div>
            <h2>{liable.label}</h2>
            <div className="dispute-badges">
              <span className={`dispute-badge ${dispute.refund_issued ? "refund-yes" : "refund-no"}`}>
                {dispute.refund_issued ? "💸 Refund issued" : "🚫 No refund"}
              </span>
              {dispute.verdict && <span className="dispute-badge verdict-code">{dispute.verdict}</span>}
            </div>
            {dispute.explanation && <p className="dispute-explanation">{localizedText(dispute.explanation)}</p>}
            <p className="dispute-foot">Resolved by the arbiter over the append-only ledger's cryptographic evidence.</p>
          </div>
        )}
        {disputeError && <div className="connection-error" role="alert">{disputeError}</div>}

        <div className="verdict-summary" aria-label="Decision summary"><span className="summary-approve">{verdictCounts.approve} approved</span><span className="summary-escalate">{verdictCounts.escalate} need approval</span><span className="summary-reject">{verdictCounts.reject} rejected</span></div>
        <section className="account-summary">
          <div><span>PERMISSION STATUS</span><b className={`account-status account-${status.toLowerCase()}`}>{status}</b></div>
          <div><span>SPENT SO FAR</span><strong>{amount(mandate?.live_state.amount_spent ?? 0, mandate?.mandate.constraints?.currency)}</strong></div>
          <div><span>PURCHASES USED</span><strong>{mandate ? `${mandate.live_state.uses_count}/${mandate.mandate.constraints?.max_uses ?? "—"}` : "—"}</strong></div>
        </section>
        <section className="timeline-panel"><div className="panel-title"><span>SATURDAY'S DECISIONS</span><small>{events.length} EVENTS</small></div>
          {loading ? <p className="empty-copy">Loading your activity…</p> : events.length ? <div className="timeline">{events.map((event) => (
            <article className="timeline-event" key={event.event_id}>
              <div className={`timeline-dot verdict-dot-${event.verdict?.toLowerCase() ?? "neutral"}`} />
              <div>
                <div className="event-meta"><span>{formatDate(event.timestamp)}</span><b>{auditTypeLabel(event.type)}</b>{event.verdict && <i className={`verdict-tag verdict-${event.verdict.toLowerCase()}`}>{verdictLabel(event.verdict)}</i>}</div>
                <p>{localizedText(event.summary)}</p>
                {isDisputable(event) && (
                  <button className="dispute-button" disabled={disputingId !== null} onClick={() => void fileDispute(event.attempt_id!)} type="button">
                    {disputingId === event.attempt_id ? "RESOLVING DISPUTE…" : "⚖ I don't recognize this charge — dispute"}
                  </button>
                )}
              </div>
            </article>
          ))}</div> : <p className="empty-copy">No activity yet — run Saturday to get started.</p>}
        </section>
      </section>
    </main>
  );
}
