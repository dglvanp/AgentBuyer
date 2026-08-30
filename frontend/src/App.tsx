import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Saturday, { type SaturdayState } from "./components/Saturday";
import MandateCreator from "./components/MandateCreator";
import AccountView from "./components/AccountView";
import AuditView from "./components/AuditView";
import { checkDetailLabel, checkRuleLabel, displayName, localizedText, saturdayStateLabel, translateBackendText, verdictLabel } from "./lib/presentation";

import { getApiBase } from "./config";
const API_BASE = getApiBase();

type LiveState = {
  status: "active" | "revoked" | "expired";
  uses_count: number;
  amount_spent: number;
  revoked_at: string | null;
};

type Condition = { type: string; value: number };
type Constraints = {
  max_amount_per_purchase?: number;
  currency?: string;
  allowed_categories?: string[];
  allowed_merchants?: string[];
  max_uses?: number;
  conditions?: Condition[];
};

type SearchFields = {
  origin?: string;
  destination?: string;
  departure_date?: string;
};

type MandateRecord = {
  mandate: { mandate_id: string; human?: { name?: string }; agent?: { id?: string }; constraints?: Constraints; search_fields?: SearchFields };
  live_state: LiveState;
};

type Flight = { id: string; route: string; price: number; category: string; merchant_id: string; merchant?: string; details?: string; url?: string; source?: "web" };
type Check = { rule: string; pass: boolean; detail: string };
type Verification = { attempt_id?: string; mandate_id?: string; verdict: "APPROVE" | "ESCALATE" | "REJECT"; checks: Check[]; human_readable?: string };
type AgentRun = {
  attempt_id?: string | null;
  discovery_source?: string;
  verification?: Verification;
  verdict?: Verification["verdict"];
  checks?: Check[];
  human_readable?: string;
  selected_flight?: Flight | null;
  flights_seen?: Flight[];
  selection_reason?: string;
  no_offers?: boolean;
  purchase_completed?: boolean;
};

type Toast = { id: number; tone: "approve" | "escalate" | "reject"; message: string };

type DecisionPhase = "idle" | "discovering" | "evaluating" | "choosing" | "verifying";
type AppView = "mission" | "account" | "audit";
type DemoAct = 1 | 2 | 3 | 4 | 5;
type DemoTourStop = "purchases" | "audit";

const DEMO_ACTS: Record<DemoAct, { title: string; copy: string }> = {
  1: { title: "ISSUANCE", copy: "A human authorizes Saturday with verifiable limits." },
  2: { title: "DISCOVERY", copy: "Saturday searches real offers." },
  3: { title: "VERIFICATION", copy: "The guardian checks every rule." },
  4: { title: "FINE-PRINT TRAP", copy: "A suspicious purchase — watch the system catch it." },
  5: { title: "REVOCATION", copy: "Marta revokes — Saturday is blocked instantly." },
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!response.ok) {
    // El backend explica sus 404/409/422 en `detail`; se traduce en la capa
    // de presentación (clave para los errores de la revisión humana).
    let message = `The system responded ${response.status}.`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (typeof body.detail === "string" && body.detail) message = translateBackendText(body.detail);
    } catch { /* cuerpo no-JSON: se conserva el mensaje genérico */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

async function requestWithTimeout<T>(path: string, options: RequestInit, timeoutMs: number, externalSignal?: AbortSignal): Promise<T | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(abort, timeoutMs);
  try {
    return await request<T>(path, { ...options, signal: controller.signal });
  } catch (caught) {
    if (controller.signal.aborted) return null;
    throw caught;
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abort);
  }
}

function verdictState(verdict: Verification["verdict"]): SaturdayState {
  return verdict === "APPROVE" ? "approve" : verdict === "ESCALATE" ? "escalate" : "reject";
}

function amount(value?: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(value ?? 0);
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function merchantName(flight?: Flight | null) {
  if (!flight) return "el comercio";
  return flight.merchant ?? (flight.merchant_id ? displayName(flight.merchant_id) : "el comercio");
}

function toastFor(run: AgentRun, result: Verification): Omit<Toast, "id"> {
  const flight = run.selected_flight;
  const purchaseAmount = flight?.price;
  const merchant = merchantName(flight);
  if (result.verdict === "APPROVE") return { tone: "approve", message: `💳 Payment approved — ${amount(purchaseAmount)} at ${merchant}` };
  if (result.verdict === "ESCALATE") return { tone: "escalate", message: `⏸ Needs your approval — ${amount(purchaseAmount)} at ${merchant}` };
  const revoked = result.checks.some((check) => check.rule === "status" && !check.pass && check.detail.toLowerCase().includes("revocado"));
  return revoked
    ? { tone: "reject", message: "🔒 Payment blocked — mandate revoked" }
    : { tone: "reject", message: "⚠ Attempt blocked — verification failed" };
}

type MissionControlProps = {
  mandateId: string;
  onCreateNew: () => void;
  onNavigate: (view: AppView) => void;
  autoStartDemoAt?: DemoAct;
  onDemoAutostarted?: () => void;
  onDemoFinished?: () => void;
};

function MissionControl({ mandateId, onCreateNew, onNavigate, autoStartDemoAt, onDemoAutostarted, onDemoFinished }: MissionControlProps) {
  const [mandate, setMandate] = useState<MandateRecord | null>(null);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [pendingVerification, setPendingVerification] = useState<Verification | null>(null);
  const [activity, setActivity] = useState<AgentRun | null>(null);
  const [saturdayState, setSaturdayState] = useState<SaturdayState>("idle");
  const [busy, setBusy] = useState<"loading" | "running" | "revoking" | "resetting" | "reviewing" | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [phase, setPhase] = useState<DecisionPhase>("idle");
  const [revealedChecks, setRevealedChecks] = useState(0);
  // Intento escalado pendiente de la decisión humana (approve/decline).
  const [escalatedAttemptId, setEscalatedAttemptId] = useState<string | null>(null);
  // La búsqueda web real no devolvió vuelos (ya no existe catálogo demo de respaldo).
  const [noOffers, setNoOffers] = useState(false);
  const [demoAct, setDemoAct] = useState<DemoAct | null>(null);
  const [demoViewAct, setDemoViewAct] = useState<DemoAct | null>(null);
  const [demoRunning, setDemoRunning] = useState(false);
  const [demoExecuting, setDemoExecuting] = useState(false);
  const [demoPaused, setDemoPaused] = useState(false);
  const [showDemoStage, setShowDemoStage] = useState(false);
  const demoTimer = useRef<number | null>(null);
  const demoAbort = useRef<AbortController | null>(null);
  const demoAdvance = useRef<() => void>(() => undefined);
  const demoRunningRef = useRef(false);
  const demoExecutingRef = useRef(false);
  const demoPausedRef = useRef(false);
  const demoExecutedActs = useRef<Set<DemoAct>>(new Set());
  const demoDiscoveryStarted = useRef(false);
  // Guarda de un solo disparo para el autostart de la demo: el efecto puede
  // re-ejecutarse (identidad nueva de onDemoAutostarted en cada render de App,
  // remounts, etc.) pero el arranque debe ocurrir una única vez por montaje.
  const demoAutostartFired = useRef(false);

  const constraints = mandate?.mandate.constraints ?? {};
  const priceLimit = useMemo(
    () => constraints.conditions?.find((condition) => condition.type === "price_below")?.value,
    [constraints.conditions],
  );
  const evaluationLimit = Math.min(
    constraints.max_amount_per_purchase ?? Number.POSITIVE_INFINITY,
    priceLimit ?? Number.POSITIVE_INFINITY,
  );
  const phaseCopy: Record<DecisionPhase, string> = {
    idle: "",
    discovering: "Searching for real flights on the web…",
    evaluating: "Checking your limits…",
    choosing: "Picking the best option…",
    verifying: "Verifying with the gatekeeper…",
  };

  const loadMission = useCallback(async (preserveSaturday = false) => {
    setBusy("loading");
    setError(null);
    try {
      // Solo el mandato: los vuelos llegan de la búsqueda web real al correr el agente.
      const mandateData = await request<MandateRecord>(`/mandates/${mandateId}`);
      setMandate(mandateData);
      if (!preserveSaturday) setSaturdayState(mandateData.live_state.status === "revoked" ? "reject" : "idle");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No connection to the system.");
    } finally {
      setBusy(null);
    }
  }, [mandateId]);

  useEffect(() => { void loadMission(); }, [loadMission]);
  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  async function runAgent(options: { timeoutMs?: number; silentErrors?: boolean; signal?: AbortSignal } = {}): Promise<AgentRun | null> {
    setBusy("running");
    setError(null);
    // Un nuevo intento no debe mostrar el veredicto ni relato del intento anterior.
    setVerification(null);
    setPendingVerification(null);
    setActivity(null);
    setFlights([]);
    setRevealedChecks(0);
    setEscalatedAttemptId(null);
    setNoOffers(false);
    setSaturdayState("thinking");

    try {
      // La búsqueda web real puede tardar hasta un minuto; la fase "discovering"
      // dura lo que dure la petición, sin animaciones inventadas.
      setPhase("discovering");
      const run = options.timeoutMs
        ? await requestWithTimeout<AgentRun>("/agent/run", {
            method: "POST",
            body: JSON.stringify({
              mandate_id: mandateId,
              ...(mandate?.mandate.search_fields ? { search_fields: mandate.mandate.search_fields } : {}),
            }),
          }, options.timeoutMs, options.signal)
        : await request<AgentRun>("/agent/run", {
            method: "POST",
            body: JSON.stringify({
              mandate_id: mandateId,
              ...(mandate?.mandate.search_fields ? { search_fields: mandate.mandate.search_fields } : {}),
            }),
          });

      if (!run) {
        setSaturdayState(mandate?.live_state.status === "revoked" ? "reject" : "idle");
        return null;
      }

      // La búsqueda siempre se conserva antes de decidir el veredicto. Un REJECT
      // también debe explicar qué ofertas encontró Saturday y cuál intentó usar.
      const discoveredFlights = run.flights_seen ?? [];
      setFlights(discoveredFlights);
      setActivity(run);

      // Si no hubo selección y tampoco ofertas, se dice tal cual.
      if (!run.selected_flight) {
        setNoOffers(discoveredFlights.length === 0);
        setSaturdayState(mandate?.live_state.status === "revoked" ? "reject" : "idle");
        return run;
      }

      const result: Verification = run.verification ?? {
        verdict: run.verdict ?? "REJECT",
        checks: run.checks ?? [],
        human_readable: run.human_readable,
      };
      setPhase("evaluating");
      await wait(850);
      setPhase("choosing");
      await wait(700);

      setPhase("verifying");
      setPendingVerification(result);
      for (let index = 1; index <= result.checks.length; index += 1) {
        setRevealedChecks(index);
        await wait(160);
      }
      setVerification(result);
      setPendingVerification(null);
      // Una escalación queda pendiente de la decisión humana (approve/decline).
      setEscalatedAttemptId(result.verdict === "ESCALATE" ? run.attempt_id ?? null : null);
      setSaturdayState(verdictState(result.verdict));
      setToast({ id: Date.now(), ...toastFor(run, result) });
      const mandateData = await request<MandateRecord>(`/mandates/${mandateId}`);
      setMandate(mandateData);
      return run;
    } catch (caught) {
      if (!options.silentErrors) setError(caught instanceof Error ? caught.message : "No connection to the system.");
      setSaturdayState(mandate?.live_state.status === "revoked" ? "reject" : "idle");
      return null;
    } finally {
      setPhase("idle");
      setBusy(null);
    }
  }

  async function revokeMandate() {
    setBusy("revoking");
    setError(null);
    try {
      await request<MandateRecord>(`/mandates/${mandateId}/revoke`, { method: "POST" });
      const mandateData = await request<MandateRecord>(`/mandates/${mandateId}`);
      setMandate(mandateData);
      // La aprobación anterior ya no representa el estado real del mandato.
      setVerification(null);
      setPendingVerification(null);
      setActivity(null);
      setFlights([]);
      setNoOffers(false);
      setRevealedChecks(0);
      setEscalatedAttemptId(null);
      setPhase("idle");
      setSaturdayState("reject");
      setToast({ id: Date.now(), tone: "reject", message: "🔒 Mandato revocado — Saturday ya no puede comprar" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No connection to the system.");
    } finally {
      setBusy(null);
    }
  }

  async function reviewEscalation(decision: "approve" | "decline") {
    if (!escalatedAttemptId) return;
    setBusy("reviewing");
    setError(null);
    try {
      const result = await request<Verification>(`/mandates/${mandateId}/approve_escalation`, {
        method: "POST",
        body: JSON.stringify({ purchase_attempt_id: escalatedAttemptId, decision }),
      });
      // La respuesta tiene la misma forma que /verify: se renderiza como cualquier veredicto.
      setVerification(result);
      setSaturdayState(verdictState(result.verdict));
      setEscalatedAttemptId(null);
      setToast({
        id: Date.now(),
        tone: decision === "approve" ? "approve" : "reject",
        message: decision === "approve" ? "✅ Aprobaste la compra — registrada" : "🚫 Rechazaste la compra",
      });
      const mandateData = await request<MandateRecord>(`/mandates/${mandateId}`);
      setMandate(mandateData);
    } catch (caught) {
      // El mandato pudo revocarse entre la escalación y la decisión: el backend lo explica.
      setError(caught instanceof Error ? caught.message : "No connection to the system.");
    } finally {
      setBusy(null);
    }
  }

  async function resetMission() {
    setBusy("resetting");
    setError(null);
    try {
      await request<{ status: string }>("/audit/reset", { method: "POST" });
      const record = await request<MandateRecord>(`/mandates/${mandateId}/reset`, { method: "POST" });
      setMandate(record);
      setVerification(null);
      setPendingVerification(null);
      setActivity(null);
      setFlights([]);
      setNoOffers(false);
      setRevealedChecks(0);
      setEscalatedAttemptId(null);
      setPhase("idle");
      setSaturdayState("idle");
      setToast(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No connection to the system.");
    } finally {
      setBusy(null);
    }
  }

  function clearDemoTimer() {
    if (demoTimer.current !== null) window.clearTimeout(demoTimer.current);
    demoTimer.current = null;
  }

  function stopDemo() {
    clearDemoTimer();
    demoAbort.current?.abort();
    demoAbort.current = null;
    demoRunningRef.current = false;
    demoExecutingRef.current = false;
    setDemoRunning(false);
    setDemoExecuting(false);
    setDemoAct(null);
    setDemoViewAct(null);
    setDemoPaused(false);
    demoPausedRef.current = false;
    setShowDemoStage(false);
    setBusy(null);
    setPhase("idle");
  }

  function demoPurchase(description: string) {
    const cap = constraints.max_amount_per_purchase ?? 150;
    const conditionCap = priceLimit ?? cap;
    const amountToTry = Math.max(1, Math.min(100, cap - 0.01, conditionCap - 0.01));
    return {
      attempt_id: `att_demo_${Date.now().toString(36)}`,
      mandate_id: mandateId,
      presented_by_agent: mandate?.mandate.agent?.id ?? "agt_saturday",
      purchase: {
        merchant_id: constraints.allowed_merchants?.[0] ?? "mch_vuelaya",
        category: constraints.allowed_categories?.[0] ?? "travel.flights",
        amount: amountToTry,
        currency: constraints.currency ?? "USD",
        description,
        metadata: { price: amountToTry, source: "demo" },
      },
    };
  }

  async function runDemoVerification(description: string) {
    const signal = demoAbort.current?.signal;
    setBusy("running");
    setVerification(null);
    setPendingVerification(null);
    setRevealedChecks(0);
    setPhase("verifying");
    setSaturdayState("thinking");
    try {
      const result = await requestWithTimeout<Verification>("/verify", {
        method: "POST",
        body: JSON.stringify(demoPurchase(description)),
      }, 8000, signal);
      if (!result || signal?.aborted) return;
      setPendingVerification(result);
      for (let index = 1; index <= result.checks.length; index += 1) {
        if (signal?.aborted) return;
        setRevealedChecks(index);
        await wait(140);
      }
      if (signal?.aborted) return;
      setVerification(result);
      setPendingVerification(null);
      setActivity((previous) => ({
        ...(previous ?? {}),
        attempt_id: result.attempt_id ?? null,
        verification: result,
        human_readable: result.human_readable,
        purchase_completed: result.verdict === "APPROVE",
      }));
      setSaturdayState(verdictState(result.verdict));
      const mandateData = await requestWithTimeout<MandateRecord>(`/mandates/${mandateId}`, { method: "GET" }, 8000, signal);
      if (mandateData && !signal?.aborted) setMandate(mandateData);
    } catch {
      // El modo demo conserva la pantalla utilizable aunque una llamada falle.
    } finally {
      if (!signal?.aborted) {
        setPhase("idle");
        setBusy(null);
      }
    }
  }

  async function performDemoAct(act: DemoAct) {
    const signal = demoAbort.current?.signal;
    if (signal?.aborted) return;
    // One real side effect per act. Visual replay uses demoViewAct only and
    // never gets here, which also protects development Strict Mode remounts.
    if (demoExecutedActs.current.has(act)) return;
    demoExecutedActs.current.add(act);
    if (act === 1) {
      const auditReset = await requestWithTimeout<{ status: string }>("/audit/reset", { method: "POST" }, 8000, signal);
      if (!auditReset || signal?.aborted) return;
      const record = await requestWithTimeout<MandateRecord>(`/mandates/${mandateId}/reset`, { method: "POST" }, 8000, signal);
      if (record && !signal?.aborted) {
        setMandate(record);
        setVerification(null); setPendingVerification(null); setActivity(null); setFlights([]); setNoOffers(false);
        setRevealedChecks(0); setEscalatedAttemptId(null); setSaturdayState("idle");
      }
      return;
    }
    if (act === 2) {
      // Mismo camino que el botón "RUN AGENT": runAgent() puebla el estado
      // `flights` que lee el panel izquierdo. La búsqueda web real tarda hasta
      // ~1 min, así que el timeout es sólo un tope de seguridad (para STOP DEMO
      // o desmontaje) y DEBE ser mayor que la latencia real del backend; con
      // 8 s abortábamos la respuesta y el panel quedaba vacío.
      if (demoDiscoveryStarted.current) return;
      demoDiscoveryStarted.current = true;
      await runAgent({ timeoutMs: 120000, silentErrors: true, signal });
      return;
    }
    if (act === 4) {
      await runDemoVerification("Demonstration flight with an automatic upgrade outside the mandate in 48 hours");
      return;
    }
    if (act === 5) {
      const revoked = await requestWithTimeout<MandateRecord>(`/mandates/${mandateId}/revoke`, { method: "POST" }, 8000, signal);
      if (revoked && !signal?.aborted) {
        setMandate(revoked);
        setSaturdayState("reject");
      }
      if (!signal?.aborted) await runDemoVerification("Real purchase attempt after mandate revocation");
    }
  }

  function scheduleDemoPause() {
    clearDemoTimer();
    if (demoPausedRef.current) return;
    // La demo está pensada para narrarse: el teclado/botón manda. Esto es sólo
    // un respaldo para no dejar una sesión abandonada detenida indefinidamente.
    demoTimer.current = window.setTimeout(() => demoAdvance.current(), 15000);
  }

  async function advanceDemo() {
    if (!demoRunningRef.current || demoExecutingRef.current || !demoAct) return;
    clearDemoTimer();
    const next = demoAct === 5 ? null : ((demoAct + 1) as DemoAct);
    if (next === null) {
      demoRunningRef.current = false;
      setDemoRunning(false);
      setDemoExecuting(false);
      setBusy(null);
      onDemoFinished?.();
      return;
    }
    demoExecutingRef.current = true;
    setDemoExecuting(true);
    setDemoAct(next);
    setDemoViewAct(next);
    await performDemoAct(next);
    if (!demoRunningRef.current || demoAbort.current?.signal.aborted) return;
    demoExecutingRef.current = false;
    setDemoExecuting(false);
    scheduleDemoPause();
  }

  async function startDemo(initialAct: DemoAct = 1) {
    if (demoRunningRef.current || busy !== null) return;
    clearDemoTimer();
    demoExecutedActs.current.clear();
    demoDiscoveryStarted.current = false;
    demoAbort.current = new AbortController();
    demoRunningRef.current = true;
    demoExecutingRef.current = true;
    demoPausedRef.current = false;
    setDemoRunning(true);
    setDemoExecuting(true);
    setDemoPaused(false);
    setDemoAct(initialAct);
    setDemoViewAct(initialAct);
    await performDemoAct(initialAct);
    if (!demoRunningRef.current || demoAbort.current.signal.aborted) return;
    demoExecutingRef.current = false;
    setDemoExecuting(false);
    scheduleDemoPause();
  }

  function advanceDemoPresentation() {
    if (!demoRunningRef.current || demoExecutingRef.current || !demoAct || !demoViewAct) return;
    clearDemoTimer();
    // Returning from a previous visual act only restores the current story beat;
    // it deliberately does not call the backend a second time.
    if (demoViewAct < demoAct) {
      setDemoViewAct(demoAct);
      scheduleDemoPause();
      return;
    }
    void advanceDemo();
  }

  function previousDemoPresentation() {
    if (!demoRunningRef.current || demoExecutingRef.current || !demoViewAct || demoViewAct <= 1) return;
    clearDemoTimer();
    demoPausedRef.current = true;
    setDemoPaused(true);
    setDemoViewAct((demoViewAct - 1) as DemoAct);
  }

  function toggleDemoPause() {
    if (!demoRunningRef.current || demoExecutingRef.current) return;
    const nextPaused = !demoPausedRef.current;
    demoPausedRef.current = nextPaused;
    setDemoPaused(nextPaused);
    clearDemoTimer();
    if (!nextPaused) scheduleDemoPause();
  }

  demoAdvance.current = () => advanceDemoPresentation();

  useEffect(() => {
    if (!demoViewAct) { setShowDemoStage(false); return; }
    setShowDemoStage(true);
    const timer = window.setTimeout(() => setShowDemoStage(false), 4500);
    return () => window.clearTimeout(timer);
  }, [demoViewAct]);

  useEffect(() => {
    // Una sola vez por montaje, pase lo que pase con las dependencias del efecto.
    if (demoAutostartFired.current) return;
    if (!autoStartDemoAt || !mandate || demoRunningRef.current || busy !== null) return;
    demoAutostartFired.current = true;
    onDemoAutostarted?.();
    void startDemo(autoStartDemoAt);
  }, [autoStartDemoAt, mandate, busy, onDemoAutostarted]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!demoRunning || demoExecuting) return;
      if (event.key === " " || event.key === "ArrowRight") {
        event.preventDefault();
        advanceDemoPresentation();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [demoRunning, demoExecuting, demoAct]);

  useEffect(() => {
    // Al desmontar de verdad: corta los timers de la demo y cualquier petición
    // en vuelo. (Sin StrictMode ya no hay montaje/desmontaje simulado, así que
    // el abort directo es correcto y no hace falta diferirlo.)
    return () => {
      clearDemoTimer();
      demoAbort.current?.abort();
    };
  }, []);

  const status = mandate?.live_state.status ?? "loading";
  const statusLabel = status === "active" ? "ACTIVE" : status === "revoked" ? "REVOKED" : status === "expired" ? "EXPIRED" : "LOADING";
  const displayedVerification = verification ?? pendingVerification;
  const displayedChecks = verification
    ? verification.checks
    : pendingVerification?.checks.slice(0, revealedChecks) ?? [];

  return (
    <main className="mission-shell">
      <div className="starfield" aria-hidden="true" />
      <div className="mission-control">
        <header className="mission-header">
          <div>
            <p className="mission-kicker">AGENTBUYER / MISSION CONTROL</p>
            <h1>Centro de confianza para agentes</h1>
          </div>
          <div className="mission-header-actions">
            <button className="new-mandate-button" onClick={() => { if (window.confirm("Leave and create a new permission? The current view will be cleared.")) onCreateNew(); }} disabled={busy !== null || demoRunning} type="button">+ START OVER</button>
            <button className="refresh-button" onClick={() => void resetMission()} disabled={busy !== null || demoRunning} type="button">
              {busy === "resetting" ? "RESETTING…" : "↻ RESET VIEW"}
            </button>
            {demoRunning ? (
              <button className="demo-stop-button" onClick={stopDemo} type="button">STOP DEMO</button>
            ) : (
              <button className="demo-start-button" onClick={() => void startDemo()} disabled={busy !== null} type="button">▶ START DEMO</button>
            )}
          </div>
        </header>

        {error && <div className="connection-error" role="alert"><strong>Something went wrong.</strong> {error} Check that FastAPI is running on port 8000.</div>}
        <AnimatePresence>
          {toast && <motion.div className={`push-toast toast-${toast.tone}`} key={toast.id} initial={{ opacity: 0, x: 72, y: -10 }} animate={{ opacity: 1, x: 0, y: 0 }} exit={{ opacity: 0, x: 72, y: -10 }} transition={{ type: "spring", stiffness: 330, damping: 28 }} role="status">{toast.message}</motion.div>}
        </AnimatePresence>

        <AnimatePresence>
          {demoAct && demoViewAct && showDemoStage && <motion.section className="demo-stage" key={demoViewAct} initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.24 }} aria-live="polite">
            <div><span>ACT {demoViewAct} · {DEMO_ACTS[demoViewAct].title}</span><p>{DEMO_ACTS[demoViewAct].copy}</p></div>
            <div className="demo-stage-actions">
              <small>{demoRunning ? (demoExecuting ? "RUNNING REAL ACTION…" : demoPaused ? "PAUSED" : "WAITING FOR PRESENTER · SPACE OR →") : "DEMO FINISHED · MANUAL CONTROL"}</small>
            </div>
          </motion.section>}
        </AnimatePresence>
        {demoRunning && demoViewAct && <aside className="demo-playback" aria-label="Demo playback controls">
          <button type="button" disabled={demoExecuting || demoViewAct <= 1} onClick={previousDemoPresentation} aria-label="Previous act">←</button>
          <button type="button" disabled={demoExecuting} onClick={toggleDemoPause}>{demoPaused ? "▶" : "Ⅱ"}</button>
          <button type="button" disabled={demoExecuting} onClick={advanceDemoPresentation} aria-label="Next act">→</button>
          <span>Act {demoViewAct} of 5</span>
        </aside>}

        <section className="mandate-panel">
          <div className="mandate-heading">
            <div>
              <p className="panel-eyebrow">ACTIVE MANDATE · {mandate?.mandate.human?.name ?? "MARTA"}</p>
              <h2>{mandate?.mandate.mandate_id ?? mandateId}</h2>
            </div>
            <span className={`status-pill status-${status}`}>{statusLabel}</span>
          </div>
          <div className="limit-grid">
            <div><span>MAX PER PURCHASE</span><strong>{amount(constraints.max_amount_per_purchase, constraints.currency)}</strong></div>
            <div><span>CATEGORY</span><strong>{constraints.allowed_categories?.[0] ? displayName(constraints.allowed_categories[0]) : "—"}</strong></div>
            <div><span>MERCHANT</span><strong>{constraints.allowed_merchants?.[0] ? displayName(constraints.allowed_merchants[0]) : "—"}</strong></div>
            <div><span>USES</span><strong>{mandate ? `${mandate.live_state.uses_count}/${constraints.max_uses ?? "—"}` : "—"}</strong></div>
            <div><span>CONDITION</span><strong>price &lt; {amount(priceLimit, constraints.currency)}</strong></div>
          </div>
        </section>

        <section className="control-grid">
          <aside className="side-panel flights-panel">
            <div className="panel-title"><span>SATURDAY'S SEARCH</span><small>{phase === "discovering" ? "SEARCHING" : activity?.selected_flight ? "CHOICE MADE" : noOffers ? "NO RESULTS" : flights.length ? "EVALUATING" : "STANDING BY"}</small></div>

            {phase === "discovering" && (
              <div className="search-live" role="status">
                <span className="search-pulse" aria-hidden="true" />
                <p>Saturday is searching for real flights on the web…<br /><small>This can take up to a minute.</small></p>
              </div>
            )}

            {phase !== "discovering" && noOffers && (
              <p className="no-offers-note" role="status">
                Saturday couldn't find flights right now — try again.
              </p>
            )}

            {/* Momento héroe: la elección de Saturday, una sola tarjeta protagonista. */}
            {phase === "idle" && activity?.selected_flight && (() => {
              const chosen = activity.selected_flight;
              if (!chosen) return null;
              const others = flights.filter((flight) => flight.id !== chosen.id);
              const verdict = verification?.verdict ?? activity.verification?.verdict;
              const heroBadge = activity.purchase_completed
                ? { tone: "approve", text: "✓ Purchased" }
                : verdict === "ESCALATE"
                  ? { tone: "escalate", text: "⏸ Waiting for your approval" }
                  : verdict === "APPROVE"
                    ? { tone: "approve", text: "✓ Approved" }
                    : { tone: "reject", text: "✕ Blocked" };
              const withinLimit = chosen.price < (priceLimit ?? Number.POSITIVE_INFINITY)
                && chosen.price <= (constraints.max_amount_per_purchase ?? Number.POSITIVE_INFINITY);
              return (
                <>
                  <motion.article className={`flight-hero ${withinLimit ? "" : "flight-hero-risk"}`} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
                    <p className="hero-kicker">SATURDAY PICKED THIS FLIGHT FOR YOU</p>
                    <div className="hero-main">
                      <strong className="hero-route">{chosen.route.replace("->", " → ")}</strong>
                      <strong className="hero-price">{amount(chosen.price)}</strong>
                    </div>
                    <p className="hero-merchant">{merchantName(chosen)}{chosen.details ? ` · ${chosen.details}` : ""}</p>
                    <p className="hero-reason">{withinLimit ? "The cheapest option that meets your price condition." : "No option met your limit; it attempted the cheapest one available."}</p>
                    <span className={`hero-badge badge-${heroBadge.tone}`}>{heroBadge.text}</span>
                  </motion.article>
                  {others.length > 0 && (
                    <div className="other-options">
                      <p className="other-options-title">Other options Saturday found</p>
                      {others.map((flight) => (
                        <div className="other-option" key={flight.id}>
                          <span>{merchantName(flight)}{flight.details ? ` · ${flight.details}` : ""}</span>
                          <b>{amount(flight.price)}</b>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}

            {/* Mientras evalúa/elige/verifica: las opciones reales, sin protagonismo aún. */}
            {(phase === "evaluating" || phase === "choosing" || phase === "verifying") && (
              <div className="flight-list">
                {flights.map((flight) => {
                  const passesLimit = flight.price <= (constraints.max_amount_per_purchase ?? Number.POSITIVE_INFINITY)
                    && flight.price < (priceLimit ?? Number.POSITIVE_INFINITY);
                  return (
                    <motion.article className={`flight-card ${passesLimit ? "flight-eligible" : "flight-ineligible"}`} key={flight.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
                      <div><p>{flight.route.replace("->", " → ")}</p><span>{merchantName(flight)}</span><em>{passesLimit ? "within your limit" : `exceeds ${amount(evaluationLimit, constraints.currency)}`}</em></div>
                      <div className="flight-price"><strong>{amount(flight.price)}</strong></div>
                    </motion.article>
                  );
                })}
              </div>
            )}

            {phase === "idle" && flights.length > 0 && !activity?.selected_flight && (
              <div className="flight-list">
                {flights.map((flight) => {
                  const passesLimit = flight.price <= (constraints.max_amount_per_purchase ?? Number.POSITIVE_INFINITY)
                    && flight.price < (priceLimit ?? Number.POSITIVE_INFINITY);
                  return (
                    <motion.article className={`flight-card ${passesLimit ? "flight-eligible" : "flight-ineligible"}`} key={flight.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
                      <div><p>{flight.route.replace("->", " → ")}</p><span>{merchantName(flight)}</span><em>{passesLimit ? "offer discovered" : `exceeds ${amount(evaluationLimit, constraints.currency)}`}</em></div>
                      <div className="flight-price"><strong>{amount(flight.price)}</strong></div>
                    </motion.article>
                  );
                })}
              </div>
            )}

            {phase === "idle" && !activity && flights.length === 0 && !noOffers && (
              <p className="empty-copy">{status === "revoked" ? "Mandate revoked — you can still run the agent to watch the attempt get blocked." : "Run Saturday: it will search for real flights on the web within your permission."}</p>
            )}
          </aside>

          <section className="saturday-command">
            <p className="agent-label">SATURDAY / AUTHORIZED AGENT</p>
            <Saturday state={saturdayState} />
            <p className={`saturday-state state-${saturdayState}`}>{phase !== "idle" ? phaseCopy[phase] : saturdayStateLabel(saturdayState)}</p>
            <div className="action-stack">
              <button className="run-button" onClick={() => void runAgent()} disabled={busy !== null || demoRunning} type="button">
                {busy === "running" ? "SATURDAY IS DECIDING…" : "RUN AGENT"}
              </button>
              <button className="revoke-button" onClick={() => void revokeMandate()} disabled={busy !== null || status === "revoked" || demoRunning} type="button">
                {busy === "revoking" ? "REVOKING…" : status === "revoked" ? "MANDATE REVOKED" : "REVOKE MANDATE"}
              </button>
            </div>
            {status === "revoked" && <p className="revoked-run-hint">The mandate is revoked — run the agent to watch the system block the attempt.</p>}
          </section>

          <aside className="side-panel verification-panel">
            <div className="panel-title"><span>VERIFICATION PANEL</span><small>{displayedVerification ? (phase === "verifying" ? "SCANNING" : "LAST ATTEMPT") : "STANDING BY"}</small></div>
            {displayedVerification ? (
              <>
                {phase === "verifying" ? <div className="verdict verdict-scanning">VERIFYING</div> : <div className={`verdict verdict-${displayedVerification.verdict.toLowerCase()}`}>{verdictLabel(displayedVerification.verdict)}</div>}
                <div className="checks-list">
                  <AnimatePresence initial={false}>
                  {displayedChecks.map((check, index) => (
                    <motion.div initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} className={`check-row ${check.pass ? "check-pass" : "check-fail"}`} key={`${check.rule}-${index}`}>
                      <b>{check.pass ? "✓" : "✕"}</b><div><strong>{checkRuleLabel(check.rule)}</strong><span>{checkDetailLabel(check.rule, check.detail)}</span></div>
                    </motion.div>
                  ))}
                  </AnimatePresence>
                </div>
                {verification?.verdict === "ESCALATE" && escalatedAttemptId && phase === "idle" && (
                  <div className="human-review">
                    <p>⚠ Escalated — nothing is approved silently. You decide:</p>
                    <div className="human-review-actions">
                      <button className="human-approve" disabled={busy !== null} onClick={() => void reviewEscalation("approve")} type="button">
                        {busy === "reviewing" ? "RECORDING…" : "✓ APPROVE"}
                      </button>
                      <button className="human-decline" disabled={busy !== null} onClick={() => void reviewEscalation("decline")} type="button">
                        ✕ DECLINE
                      </button>
                    </div>
                  </div>
                )}
                {verification && phase === "idle" && <div className="result-links">
                  {verification.verdict === "APPROVE" && <button onClick={() => onNavigate("account")} type="button">✓ Purchase recorded — see it in My purchases</button>}
                  <button onClick={() => onNavigate("audit")} type="button">This attempt is on the record — view in Audit →</button>
                </div>}
              </>
            ) : <p className="empty-copy">{status === "revoked" ? "Mandate revoked — run the agent to see the real outcome of the next attempt." : "Run Saturday to see the backend's real checks."}</p>}
          </aside>
        </section>

        <section className="activity-panel">
          <div className="panel-title"><span>AGENT ACTIVITY</span><small>{activity ? "REAL RECORD" : "NO RUNS YET"}</small></div>
          {activity ? (
            <div className="activity-content">
              <p>{localizedText(activity.human_readable ?? activity.verification?.human_readable ?? "Saturday finished its evaluation.")}</p>
              {activity.selected_flight && <span>Attempt: <b>{activity.selected_flight.route}</b> · {amount(activity.selected_flight.price)} · {activity.purchase_completed ? "purchase completed" : "purchase did not proceed"}</span>}
            </div>
          ) : <p className="empty-copy">{status === "revoked" ? "The mandate was revoked. The agent's next attempt will be recorded here." : "The discovery-and-decision story will appear here."}</p>}
        </section>
      </div>
    </main>
  );
}

function DemoTourOverlay({ stop, onNext }: { stop: DemoTourStop; onNext: () => void }) {
  const copy = stop === "purchases"
    ? { title: "MY PURCHASES", text: "The completed purchase is now part of Marta's record." }
    : { title: "AUDIT", text: "Every decision is preserved in the system-wide audit trail." };

  useEffect(() => {
    const timer = window.setTimeout(onNext, 15000);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === " " || event.key === "ArrowRight") {
        event.preventDefault();
        onNext();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", onKeyDown); };
  }, [onNext]);

  return (
    <motion.section className="demo-tour-overlay" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} aria-live="polite">
      <div><span>GUIDED DEMO · {copy.title}</span><p>{copy.text}</p></div>
      <button type="button" onClick={onNext}>Next → <kbd>Space / →</kbd></button>
    </motion.section>
  );
}

function App() {
  const [activeMandateId, setActiveMandateId] = useState<string | null>(null);
  const [view, setView] = useState<AppView>("mission");
  const [continueDemoAfterEmission, setContinueDemoAfterEmission] = useState(false);
  const [demoTourStop, setDemoTourStop] = useState<DemoTourStop | null>(null);
  const demoAutostartConsumed = useRef(false);

  const advanceDemoTour = useCallback(() => {
    if (demoTourStop === "purchases") {
      setDemoTourStop("audit");
      setView("audit");
      return;
    }
    setDemoTourStop(null);
    setView("mission");
  }, [demoTourStop]);

  if (!activeMandateId) {
    return <MandateCreator
      onCreated={(mandateId) => { demoAutostartConsumed.current = false; setContinueDemoAfterEmission(false); setDemoTourStop(null); setActiveMandateId(mandateId); setView("mission"); }}
      onDemoCreated={(mandateId) => { demoAutostartConsumed.current = false; setContinueDemoAfterEmission(true); setDemoTourStop(null); setActiveMandateId(mandateId); setView("mission"); }}
    />;
  }

  return (
    <>
      <nav className="app-nav" aria-label="Main navigation">
        <button className="nav-brand" onClick={() => setView("mission")} type="button"><span>Saturday</span><small>by AgentBuyer</small></button>
        <div className="nav-links">
          <button className={view === "mission" ? "is-active" : ""} onClick={() => setView("mission")} type="button">Mission Control</button>
          <button className={view === "account" ? "is-active" : ""} onClick={() => setView("account")} type="button">My purchases</button>
          <button className={view === "audit" ? "is-active" : ""} onClick={() => setView("audit")} type="button">Audit</button>
        </div>
      </nav>
      {demoTourStop && <DemoTourOverlay stop={demoTourStop} onNext={advanceDemoTour} />}
      {view === "mission" && <MissionControl mandateId={activeMandateId} onCreateNew={() => { demoAutostartConsumed.current = false; setContinueDemoAfterEmission(false); setDemoTourStop(null); setActiveMandateId(null); }} onNavigate={setView} autoStartDemoAt={continueDemoAfterEmission && !demoAutostartConsumed.current ? 2 : undefined} onDemoAutostarted={() => { demoAutostartConsumed.current = true; setContinueDemoAfterEmission(false); }} onDemoFinished={() => { setDemoTourStop("purchases"); setView("account"); }} />}
      {view === "account" && <AccountView mandateId={activeMandateId} />}
      {view === "audit" && <AuditView />}
    </>
  );
}

export default App;
