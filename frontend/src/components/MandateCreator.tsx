import { FormEvent, useMemo, useState, useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Saturday, { type SaturdayExpression } from "./Saturday";
import { useLivenessVerification } from "../hooks/useLivenessVerification";
import { useZeroTrustSecurity } from "../hooks/useZeroTrustSecurity";

import { getApiBase } from "../config";
const API_BASE = getApiBase();

type MandateCreatorProps = {
  onCreated: (mandateId: string) => void;
  /** Continúa el relato automático en Mission Control después de emitir el mandato. */
  onDemoCreated?: (mandateId: string) => void;
};

type VerificationStatus = "pending" | "processing" | "complete";

function verificationStatus(complete: boolean, processing: boolean): VerificationStatus {
  return complete ? "complete" : processing ? "processing" : "pending";
}

const verificationStatusLabel: Record<VerificationStatus, string> = {
  pending: "PENDING",
  processing: "IN PROGRESS",
  complete: "COMPLETED",
};

const categories = [
  { value: "travel.flights", label: "Flights" },
  { value: "travel.hotels", label: "Hotels" },
];

const merchants = [
  { value: "mch_vuelaya", label: "VuelaYa" },
  { value: "mch_despegar", label: "Despegar" },
  { value: "mch_kayak", label: "Kayak" },
  { value: "mch_expedia", label: "Expedia" },
];

// La búsqueda web real devuelve ofertas de estos sitios de viajes (vuelos y
// hoteles); un mandato de viaje debe permitirlos o toda compra real escalaría.
const TRAVEL_SEARCH_MERCHANTS = ["mch_vuelaya", "mch_despegar", "mch_kayak", "mch_expedia"];

// Suma noches a una fecha YYYY-MM-DD (check-out del hotel).
function addDays(value: string, days: number) {
  const date = dateFromKey(value);
  date.setDate(date.getDate() + days);
  return dateKey(date);
}

function endOfMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
}

// Fecha cercana (~2 semanas) para que la búsqueda web real devuelva resultados
// de forma confiable — las fechas muy lejanas suelen no tener tarifas publicadas.
function nearTermDate() {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return d.toISOString().slice(0, 10);
}

function safeId(value: string, prefix: string) {
  const readable = value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "persona";
  return `${prefix}_${readable}_${Date.now().toString(36)}`;
}

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function readableDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric" })
    .format(dateFromKey(value))
    .replace(".", "");
}

type CalendarDatePickerProps = {
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
};

function CalendarDatePicker({ value, onChange, ariaLabel = "Pick a date" }: CalendarDatePickerProps) {
  const today = useMemo(() => {
    const current = new Date();
    current.setHours(0, 0, 0, 0);
    return current;
  }, []);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setIsOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [isOpen]);
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const selected = value ? dateFromKey(value) : today;
    return new Date(selected.getFullYear(), selected.getMonth(), 1);
  });
  const monthStart = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
  const gridStart = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1 - monthStart.getDay());
  const days = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + index);
    return day;
  });
  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(visibleMonth);
  const earliestMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  function togglePicker() {
    if (!isOpen) {
      const selected = value ? dateFromKey(value) : today;
      setVisibleMonth(new Date(selected.getFullYear(), selected.getMonth(), 1));
    }
    setIsOpen((open) => !open);
  }

  return (
    <div className="date-picker" ref={containerRef}>
      <button className={`date-picker-trigger ${value ? "has-value" : ""}`} type="button" onClick={togglePicker} aria-haspopup="dialog" aria-expanded={isOpen}>
        <span>{value ? readableDate(value) : "Pick a date"}</span><b aria-hidden="true">⌄</b>
      </button>
      {isOpen && <div className="calendar-popover" role="dialog" aria-label={ariaLabel}>
        <div className="calendar-heading">
          <button type="button" onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1))} disabled={visibleMonth <= earliestMonth} aria-label="Previous month">‹</button>
          <strong>{monthLabel}</strong>
          <button type="button" onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1))} aria-label="Next month">›</button>
        </div>
        <div className="calendar-weekdays">{["S", "M", "T", "W", "T", "F", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div>
        <div className="calendar-days">
          {days.map((day) => {
            const key = dateKey(day);
            const isPast = day < today;
            const outsideMonth = day.getMonth() !== visibleMonth.getMonth();
            return <button className={`${outsideMonth ? "outside-month" : ""} ${key === value ? "is-selected" : ""}`} type="button" disabled={isPast} key={key} onClick={() => { onChange(key); setIsOpen(false); }}>{day.getDate()}</button>;
          })}
        </div>
      </div>}
    </div>
  );
}

type WizardDemoStage = "idle" | "preparing" | "biometrics" | "payment" | "limits" | "authorizing" | "paused" | "error";

const DEMO_MARTA = {
  name: "Marta",
  document: "PASSPORT-AR-948291",
  phone: "+52 56 1447 3083",
  email: "marta@example.com",
  card: "4242 4242 4242 4242",
  amount: "150",
  uses: "3",
  price: "150",
  origin: "BUE",
  destination: "COR",
};

const WIZARD_DEMO_LABELS: Record<Exclude<WizardDemoStage, "idle" | "paused" | "error">, string> = {
  preparing: "Marta verifies her identity",
  biometrics: "Verifying identity…",
  payment: "Protecting the payment method…",
  limits: "Setting verifiable limits…",
  authorizing: "Issuing the mandate…",
};

function withTimeout<T>(promise: Promise<T>, milliseconds = 8000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("The verification took too long. You can continue manually.")), milliseconds);
    promise.then((value) => { window.clearTimeout(timer); resolve(value); }, (reason) => { window.clearTimeout(timer); reject(reason); });
  });
}

/** Espera disponibilidad de un frame real; no es una pausa fija antes de verificar. */
function waitForCameraFrame(getVideo: () => HTMLVideoElement | null, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const video = getVideo();
      if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error("The camera did not provide an image within 30 seconds."));
      } else {
        window.setTimeout(check, 120);
      }
    };
    check();
  });
}

export default function MandateCreator({ onCreated, onDemoCreated }: MandateCreatorProps) {
  // Prellenado con el perfil demo de Marta: el wizard completo se recorre
  // solo con clics (sin teclear nada) para una demo rápida y confiable.
  const [humanName, setHumanName] = useState("Marta");
  const [maxAmount, setMaxAmount] = useState("150");
  const [category, setCategory] = useState("travel.flights");
  const [merchant, setMerchant] = useState("mch_vuelaya");
  const [maxUses, setMaxUses] = useState("3");
  const [priceBelow, setPriceBelow] = useState("150");
  const [validUntil, setValidUntil] = useState(endOfMonth());
  // Estos datos viajan con el permiso para que Saturday pueda buscar la ruta real.
  // Ruta por defecto BUE→COR con fecha cercana: combinación confirmada que
  // la búsqueda web real devuelve de forma confiable para la demo.
  const [flightOrigin, setFlightOrigin] = useState("BUE");
  const [flightDestination, setFlightDestination] = useState("COR");
  const [departureDate, setDepartureDate] = useState(nearTermDate());
  // Campos de hotel: dónde, check-in y cuántas noches (check-out se calcula).
  const [hotelDestination, setHotelDestination] = useState("Cordoba, Argentina");
  const [hotelCheckIn, setHotelCheckIn] = useState(nearTermDate());
  const [hotelNights, setHotelNights] = useState("3");
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3 | 4>(1);

  // 🛡️ Identidad y Datos Bancarios DLP (valores demo de Marta, editables)
  const [userIdDoc, setUserIdDoc] = useState("PASSPORT-AR-948291");
  const [userPhone, setUserPhone] = useState("+52 56 1447 3083");
  // El correo sigue capturándose: es el destino del recibo de compra.
  const [userEmail, setUserEmail] = useState("marta@example.com");
  const [cardNumber, setCardNumber] = useState("4242 4242 4242 4242");

  // Modal y Hooks Biométicos
  const [showBioModal, setShowBioModal] = useState(false);
  const [bioMode, setBioMode] = useState<"camera" | "fingerprint">("camera");
  const [passkeyVerified, setPasskeyVerified] = useState(false);
  const [tokenVerified, setTokenVerified] = useState(false);
  const [sensitiveFieldFocused, setSensitiveFieldFocused] = useState(false);
  const [editingIdentity, setEditingIdentity] = useState(false);
  const [editingBiometric, setEditingBiometric] = useState(false);
  const [microExpression, setMicroExpression] = useState<SaturdayExpression | null>(null);
  const expressionTimer = useRef<number | null>(null);
  const demoPauseResolver = useRef<(() => void) | null>(null);
  const demoPauseTimer = useRef<number | null>(null);

  const { videoRef, livenessState, startCamera, stopCamera, verifyFacePresence } = useLivenessVerification();
  const { handlePasskeyChallenge, handleTokenizeCard, paymentMethodId, errorMessage: securityError } = useZeroTrustSecurity();

  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [wizardDemoStage, setWizardDemoStage] = useState<WizardDemoStage>("idle");
  const [wizardDemoMessage, setWizardDemoMessage] = useState("");
  const [showWizardDemoLabel, setShowWizardDemoLabel] = useState(false);

  const selectedCategory = categories.find((item) => item.value === category)?.label ?? category;
  const selectedMerchant = merchants.find((item) => item.value === merchant)?.label ?? merchant;
  // Un teléfono real: al menos 10 dígitos (ignorando espacios, guiones, etc.).
  const phoneDigits = userPhone.replace(/\D/g, "");
  const phoneComplete = phoneDigits.length >= 10;
  const emailComplete = /^\S+@\S+\.\S+$/.test(userEmail.trim());
  const identityComplete = Boolean(userIdDoc.trim() && phoneComplete && emailComplete);
  const identityCollapsed = identityComplete && !editingIdentity;
  const biometricCollapsed = passkeyVerified && !editingBiometric;
  const stepOneReady = Boolean(identityComplete && passkeyVerified);
  const completedVerificationCount = Number(identityComplete) + Number(passkeyVerified);
  const identityStatus = verificationStatus(identityComplete, Boolean(userIdDoc.trim() || userPhone.trim() || userEmail.trim()));
  const biometricStatus = verificationStatus(passkeyVerified, showBioModal);
  const saturdayExpression: SaturdayExpression | undefined = sensitiveFieldFocused
    ? "covering"
    : microExpression ?? (stepOneReady || (currentStep === 2 && tokenVerified) ? "ready" : undefined);
  const summary = useMemo(
    () => `Saturday will be able to buy ${selectedCategory.toLowerCase()} at ${selectedMerchant}, up to $${maxAmount || "—"} per purchase, at most ${maxUses || "—"} times, only if the price drops below $${priceBelow || "—"}${validUntil ? `, valid until ${validUntil}.` : "."} (Enrolled with Passkey + DLP Token).`,
    [humanName, maxAmount, maxUses, priceBelow, selectedCategory, selectedMerchant, validUntil],
  );

  function showMicroExpression(expression: SaturdayExpression) {
    if (expressionTimer.current !== null) window.clearTimeout(expressionTimer.current);
    setMicroExpression(expression);
    expressionTimer.current = window.setTimeout(() => setMicroExpression(null), 850);
  }

  async function openBiometricsModal() {
    setShowBioModal(true);
    setBioMode("camera");
    try {
      await startCamera();
      setTimeout(async () => {
        try {
          await verifyFacePresence();
          setPasskeyVerified(true);
          setEditingBiometric(false);
          showMicroExpression("happy");
          setTimeout(() => setShowBioModal(false), 800);
        } catch (e) {
          console.warn("Liveness error:", e);
        }
      }, 1500);
    } catch {
      try {
        await handlePasskeyChallenge();
        setPasskeyVerified(true);
        setEditingBiometric(false);
        showMicroExpression("happy");
      } catch (err) {
        console.warn(err);
      }
    }
  }

  async function submitMandate(demo = false): Promise<boolean> {
    setError(null);
    // La demo puede arrancar con el wizard vacío: el payload se construye con
    // los mismos valores que se muestran, sin depender de un re-render previo.
    const demoValues = demo ? {
      name: humanName || DEMO_MARTA.name,
      document: userIdDoc || DEMO_MARTA.document,
      phone: userPhone || DEMO_MARTA.phone,
      email: userEmail || DEMO_MARTA.email,
      card: cardNumber || DEMO_MARTA.card,
      amount: maxAmount || DEMO_MARTA.amount,
      uses: maxUses || DEMO_MARTA.uses,
      price: priceBelow || DEMO_MARTA.price,
      origin: flightOrigin || DEMO_MARTA.origin,
      destination: flightDestination || DEMO_MARTA.destination,
      date: departureDate || nearTermDate(),
    } : { name: humanName, document: userIdDoc, phone: userPhone, email: userEmail, card: cardNumber, amount: maxAmount, uses: maxUses, price: priceBelow, origin: flightOrigin, destination: flightDestination, date: departureDate };
    const amount = Number(demoValues.amount);
    const uses = Number(demoValues.uses);
    const price = Number(demoValues.price);
    // Si falta algo del paso 3, regresamos ahí para que el error sea accionable.
    if (!demoValues.name.trim() || !Number.isFinite(amount) || amount <= 0 || !Number.isInteger(uses) || uses <= 0 || !Number.isFinite(price) || price <= 0) {
      setError("Fill in your name and the limits with valid numbers greater than zero.");
      setCurrentStep(3);
      return false;
    }

    if (category === "travel.flights" && (!demoValues.origin.trim() || !demoValues.destination.trim() || !demoValues.date)) {
      setError("Fill in origin, destination, and departure date to search for flights.");
      setCurrentStep(3);
      return false;
    }
    const nights = Number(hotelNights);
    if (category === "travel.hotels" && (!hotelDestination.trim() || !hotelCheckIn || !Number.isInteger(nights) || nights <= 0)) {
      setError("Fill in the destination, check-in date, and a valid number of nights to search for hotels.");
      setCurrentStep(3);
      return false;
    }
    if (!category || !merchant) {
      setError("Choose a category and a merchant for the permission.");
      setCurrentStep(3);
      return false;
    }

    const mandateId = safeId(demoValues.name, "mnd");
    const payload = {
      mandate_id: mandateId,
      human: {
        id: safeId(demoValues.name, "hum"),
        display_name: demoValues.name.trim(),
        id_document: demoValues.document,
        phone: demoValues.phone,
        // El recibo de compra se envía a mandate.human.email (core/notifications).
        ...(demoValues.email.trim() ? { email: demoValues.email.trim() } : {}),
      },
      agent: { id: "agt_saturday", display_name: "Saturday" },
      ...(category === "travel.flights" ? {
        search_fields: {
          origin: demoValues.origin.trim(),
          destination: demoValues.destination.trim(),
          departure_date: demoValues.date,
        },
      } : category === "travel.hotels" ? {
        search_fields: {
          destination: hotelDestination.trim(),
          check_in: hotelCheckIn,
          check_out: addDays(hotelCheckIn, nights),
          nights,
        },
      } : {}),
      constraints: {
        max_amount_per_purchase: amount,
        currency: "USD",
        allowed_categories: [category],
        allowed_merchants: category.startsWith("travel.")
          ? Array.from(new Set([merchant, ...TRAVEL_SEARCH_MERCHANTS]))
          : [merchant],
        max_uses: uses,
        conditions: [{ type: "price_below", value: price }],
        off_session_consent: true,
      },
      authentication: {
        passkey_biometrics: passkeyVerified ? "verified_webauthn_touch_id" : "unverified",
        receipt_email: demoValues.email.trim(),
      },
      payment_token: {
        token_id: paymentMethodId || `vtok_${Math.random().toString(36).slice(2, 10)}`,
        token_type: "SCOPED_VIRTUAL_TOKEN",
        masked_card: demoValues.card ? (demoValues.card.startsWith("••••") ? demoValues.card : `•••• ${demoValues.card.replace(/\D/g, "").slice(-4) || "4242"}`) : "•••• 4242",
        bank_issuer: "Stripe Elements / Galicia AI Payments",
      },
      ...(validUntil ? { valid_until: validUntil } : {}),
      signature: "ed25519_passkey_signed_jwt_token",
    };

    setCreating(true);
    try {
      const response = await fetch(`${API_BASE}/mandates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`El sistema respondió ${response.status}.`);
      if (demo) onDemoCreated?.(mandateId);
      else onCreated(mandateId);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? `We couldn't create your permission: ${caught.message}` : "We couldn't create your permission. Check the connection to the system.");
      return false;
    } finally {
      setCreating(false);
    }
  }

  async function createMandate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitMandate();
  }

  function loadMartaDemoValues() {
    setHumanName((value) => value || DEMO_MARTA.name);
    setUserIdDoc((value) => value || DEMO_MARTA.document);
    setUserPhone((value) => value || DEMO_MARTA.phone);
    setUserEmail((value) => value || DEMO_MARTA.email);
    setCardNumber((value) => value || DEMO_MARTA.card);
    setMaxAmount((value) => value || DEMO_MARTA.amount);
    setMaxUses((value) => value || DEMO_MARTA.uses);
    setPriceBelow((value) => value || DEMO_MARTA.price);
    setCategory("travel.flights");
    setMerchant("mch_vuelaya");
    setFlightOrigin((value) => value || DEMO_MARTA.origin);
    setFlightDestination((value) => value || DEMO_MARTA.destination);
    setDepartureDate((value) => value || nearTermDate());
  }

  function clearWizardDemoPause() {
    if (demoPauseTimer.current !== null) window.clearTimeout(demoPauseTimer.current);
    demoPauseTimer.current = null;
    demoPauseResolver.current = null;
  }

  function waitForNarration(message: string): Promise<void> {
    setWizardDemoStage("paused");
    setWizardDemoMessage(message);
    return new Promise((resolve) => {
      const done = () => {
        clearWizardDemoPause();
        resolve();
      };
      demoPauseResolver.current = done;
      // El control es manual; este respaldo largo evita dejar una demo abandonada.
      demoPauseTimer.current = window.setTimeout(done, 15000);
    });
  }

  function advanceWizardDemo() {
    demoPauseResolver.current?.();
  }

  async function verifyDemoPresence() {
    const deadline = Date.now() + 30000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await waitForCameraFrame(() => videoRef.current, Math.max(1, deadline - Date.now()));
        return await verifyFacePresence();
      } catch (caught) {
        lastError = caught;
        // La cámara permanece abierta: se vuelve a evaluar el siguiente frame,
        // dando tiempo a la persona de colocarse frente a ella.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 750));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Human presence could not be verified within 30 seconds.");
  }

  async function runWizardDemo() {
    if (wizardDemoStage !== "idle" && wizardDemoStage !== "error") return;
    setError(null);
    setWizardDemoStage("preparing");
    setWizardDemoMessage("ACT 1 · ISSUANCE: opening a clean audit session.");

    try {
      const auditReset = await withTimeout(fetch(`${API_BASE}/audit/reset`, { method: "POST" }));
      if (!auditReset.ok) throw new Error("The audit session could not be reset.");
      setWizardDemoMessage("ACT 1 · ISSUANCE: loading Marta's demonstration mandate.");
      loadMartaDemoValues();
      setCurrentStep(1);
      await waitForNarration("First, we confirm that Marta is the person authorizing Saturday.");

      setWizardDemoStage("biometrics");
      setWizardDemoMessage("Verifying biometrics with the real provider…");
      setShowBioModal(true);
      setBioMode("camera");
      await withTimeout(startCamera(), 30000);
      await verifyDemoPresence();
      setPasskeyVerified(true);
      setEditingBiometric(false);
      setShowBioModal(false);
      showMicroExpression("happy");
      await waitForNarration("Biometrics confirmed. Saturday never sees the card number: we tokenize it now.");

      setCurrentStep(2);
      setWizardDemoStage("payment");
      setWizardDemoMessage("Tokenizing the payment method…");
      const token = await withTimeout(handleTokenizeCard(cardNumber || DEMO_MARTA.card));
      if (!token) throw new Error("No se pudo tokenizar el método de pago.");
      setTokenVerified(true);
      await waitForNarration("Payment method protected. Now we review the limits Marta chose.");

      setCurrentStep(3);
      setWizardDemoStage("limits");
      setWizardDemoMessage("Marta authorizes VuelaYa flights up to USD 150, at most three times.");
      await waitForNarration("The limits are clear, verifiable, and under Marta's control.");

      setCurrentStep(4);
      setWizardDemoStage("authorizing");
      setWizardDemoMessage("Signing and issuing the real mandate…");
      const created = await withTimeout(submitMandate(true));
      if (!created) throw new Error("The demonstration mandate could not be created.");
    } catch (caught) {
      stopCamera();
      setShowBioModal(false);
      setWizardDemoStage("error");
      setWizardDemoMessage(caught instanceof Error ? caught.message : "The demo could not complete a real verification.");
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (wizardDemoStage === "paused" && (event.key === " " || event.key === "ArrowRight")) {
        event.preventDefault();
        advanceWizardDemo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [wizardDemoStage]);

  useEffect(() => {
    if (wizardDemoStage === "idle" || wizardDemoStage === "error") {
      setShowWizardDemoLabel(false);
      return;
    }
    setShowWizardDemoLabel(true);
    const timer = window.setTimeout(() => setShowWizardDemoLabel(false), 4500);
    return () => window.clearTimeout(timer);
  }, [wizardDemoStage]);

  useEffect(() => () => clearWizardDemoPause(), []);

  return (
    <main className="authorization-shell">
      <div className="starfield" aria-hidden="true" />
      <button className="wizard-demo-launch" type="button" onClick={() => wizardDemoStage === "paused" ? advanceWizardDemo() : void runWizardDemo()} disabled={wizardDemoStage !== "idle" && wizardDemoStage !== "error" && wizardDemoStage !== "paused"}>
        {wizardDemoStage === "paused" ? "Continue demo →" : "▶ Start demo"}
      </button>
      <AnimatePresence>
        {showWizardDemoLabel && wizardDemoStage !== "idle" && wizardDemoStage !== "error" && (
          <motion.aside className="wizard-demo-action-label" key={wizardDemoStage} initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.22 }} aria-live="polite">
            <span>GUIDED DEMO · ACT 1</span><strong>{wizardDemoStage === "paused" ? "Presenter pause — press Space or → to continue." : WIZARD_DEMO_LABELS[wizardDemoStage]}</strong>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Modal Biométrico */}
      {showBioModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(10, 14, 26, 0.94)", backdropFilter: "blur(16px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}>
          <div style={{ width: "min(420px, 94vw)", background: "#141B2E", border: "1px solid rgba(77, 124, 255, 0.4)", borderRadius: "1.5rem", padding: "1.5rem", textAlign: "center", position: "relative" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0, fontFamily: "Space Grotesk", fontSize: "1.25rem", color: "#E8ECF5" }}>Face ID & Biometrics</h2>
              <button type="button" onClick={() => { stopCamera(); setShowBioModal(false); }} style={{ background: "transparent", border: 0, color: "#8A94AD", fontSize: "1.2rem", cursor: "pointer" }}>✕</button>
            </div>

            <div style={{ position: "relative", width: "230px", height: "290px", margin: "1rem auto", borderRadius: "50%", overflow: "hidden", border: "4px solid #3DDC97", boxShadow: "0 0 30px rgba(61, 220, 151, 0.5)", background: "#000" }}>
              <video ref={videoRef} autoPlay playsInline muted style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)", display: "block" }} />
              <div style={{ position: "absolute", top: "10%", left: 0, right: 0, height: "3px", background: "#3DDC97", boxShadow: "0 0 15px #3DDC97" }} />
            </div>

            <p style={{ color: "#3DDC97", fontFamily: "Space Grotesk", fontSize: "0.85rem", fontWeight: 600 }}>
              {livenessState.error ? livenessState.error : livenessState.isLiveFaceVerified ? "✅ Human verified!" : "Center your face in the oval..."}
            </p>
          </div>
        </div>
      )}

      <section className="authorization-layout">
        <div className="authorization-intro">
          <p className="mission-kicker">AGENTBUYER / YOUR PERMISSION, YOUR LIMITS</p>
          <h1>Authorize <span>Saturday</span></h1>
          <p>Your agent can help you buy, but you define every limit. Nothing happens outside this permission.</p>
          <div className="creator-saturday"><Saturday state="idle" expression={saturdayExpression} /></div>
          <div className="trust-note"><b>Your control comes first.</b><span>You can revoke this permission anytime.</span></div>
        </div>

        {/* noValidate: hay inputs required en pasos ocultos (display:none); la
            validación nativa bloqueaba el submit sin poder mostrar su burbuja.
            La validación real vive en createMandate, con errores visibles. */}
        <form className="mandate-form" onSubmit={createMandate} noValidate>
          <div className="form-heading"><p className="panel-eyebrow">NEW PERMISSION</p><h2>Give Saturday clear instructions</h2></div>
          <div className="wizard-progress" aria-label={`Step ${currentStep} of 4`}>
            <span className={currentStep === 1 ? "is-current" : currentStep > 1 ? "is-complete" : ""}>1. Verify it's you</span>
            <span className={currentStep === 2 ? "is-current" : currentStep > 2 ? "is-complete" : ""}>2. Secure method</span>
            <span className={currentStep === 3 ? "is-current" : currentStep > 3 ? "is-complete" : ""}>3. Set the limits</span>
            <span className={currentStep === 4 ? "is-current" : ""}>4. Confirm</span>
          </div>

          <div className="wizard-step" style={{ display: currentStep === 3 ? "grid" : "none" }}>
            <h3>Set the limits</h3>
            <label>Who's authorizing?<input value={humanName} onChange={(event) => setHumanName(event.target.value)} placeholder="Your name" required /></label>
            <label>How much can it spend at most per purchase?<div className="money-field"><span>USD $</span><input value={maxAmount} onChange={(event) => setMaxAmount(event.target.value)} inputMode="decimal" placeholder="150" required /></div></label>
            <div className="form-pair">
              <label>What can it spend on?<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="" disabled>Choose a category…</option>{categories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
              <label>At which merchants?<select value={merchant} onChange={(event) => setMerchant(event.target.value)}><option value="" disabled>Choose a merchant…</option>{merchants.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>{category.startsWith("travel.") && <small className="field-hint">For travel, Saturday compares trusted sites (VuelaYa, Despegar, Kayak, Expedia) — all included in your permission.</small>}</label>
            </div>
            <div className="form-pair">
              <label>How many purchases at most?<input value={maxUses} onChange={(event) => setMaxUses(event.target.value)} inputMode="numeric" placeholder="3" required /></label>
              <label>Until when is this permission valid?<CalendarDatePicker value={validUntil} onChange={setValidUntil} ariaLabel="Pick how long the permission is valid" /></label>
            </div>
            <label>Any price condition?<div className="price-condition"><span>Only if the price drops below USD $</span><input value={priceBelow} onChange={(event) => setPriceBelow(event.target.value)} inputMode="decimal" placeholder="150" required /></div></label>
          </div>

          {category === "travel.flights" && currentStep === 3 && <div className="wizard-step flight-search-step">
            <div className="form-pair">
              <label>Origin<input value={flightOrigin} onChange={(event) => setFlightOrigin(event.target.value)} placeholder="BUE or Buenos Aires" required /></label>
              <label>Destination<input value={flightDestination} onChange={(event) => setFlightDestination(event.target.value)} placeholder="COR or Mexico City" required /></label>
            </div>
            <label>Departure date<CalendarDatePicker value={departureDate} onChange={setDepartureDate} ariaLabel="Pick the departure date" /></label>
          </div>}

          {category === "travel.hotels" && currentStep === 3 && <div className="wizard-step flight-search-step">
            <div className="form-pair">
              <label>Where will you stay?<input value={hotelDestination} onChange={(event) => setHotelDestination(event.target.value)} placeholder="Cordoba, Argentina" required /></label>
              <label>How many nights?<input value={hotelNights} onChange={(event) => setHotelNights(event.target.value)} inputMode="numeric" placeholder="3" required /></label>
            </div>
            <label>Check-in date<CalendarDatePicker value={hotelCheckIn} onChange={setHotelCheckIn} ariaLabel="Pick the check-in date" /></label>
            {hotelCheckIn && Number(hotelNights) > 0 && <small className="field-hint">Check-out: {readableDate(addDays(hotelCheckIn, Number(hotelNights)))} ({hotelNights} {Number(hotelNights) === 1 ? "night" : "nights"}).</small>}
          </div>}

          {(currentStep === 1 || currentStep === 2) && <div className="wizard-step wizard-security-step" style={{ background: "rgba(30, 41, 59, 0.6)", padding: "14px", borderRadius: "10px", border: "1px solid rgba(77, 124, 255, 0.35)", marginTop: "4px" }}>
            <h3>{currentStep === 1 ? "Verify it's you" : "Secure payment method"}</h3>

            {currentStep === 1 && <>
              <p className="verify-subtitle">Two quick verifications: identity details and your biometrics.</p>
              <div className="verify-progress" role="status">
                <span>{completedVerificationCount} of 2 verifications completed</span>
                <div className="verify-progress-bar" aria-hidden="true"><i style={{ width: `${Math.round((completedVerificationCount / 2) * 100)}%` }} /></div>
              </div>

              {/* a) Identidad: documento + teléfono */}
              <section className={`verify-item is-${identityStatus}`}>
                <header className="verify-item-heading">
                  <span className="verify-item-number" aria-hidden="true">{identityComplete ? "✓" : "1"}</span>
                  <div className="verify-item-title"><b>Identity</b><small>{identityComplete ? "Document, phone, and email captured" : "Enter your document, phone, and email"}</small></div>
                  <em className={`verify-chip is-${identityStatus}`}>{verificationStatusLabel[identityStatus]}</em>
                  {identityComplete && <button className="verify-edit" type="button" onClick={() => setEditingIdentity((editing) => !editing)}>{editingIdentity ? "Done" : "Edit"}</button>}
                </header>
                {!identityCollapsed && <div className="verify-item-body">
                  <div className="form-pair">
                    <label>
                      ID document (ID / passport)
                      <input value={userIdDoc} onChange={(e) => setUserIdDoc(e.target.value)} onFocus={() => setSensitiveFieldFocused(true)} onBlur={() => setSensitiveFieldFocused(false)} placeholder="PASSPORT-AR-948291" />
                    </label>
                    <label>
                      Contact phone
                      <input value={userPhone} onChange={(e) => setUserPhone(e.target.value)} inputMode="tel" placeholder="+52 56 1447 3083" />
                    </label>
                  </div>
                  <label>
                    Email for your purchase receipt
                    <input value={userEmail} onChange={(e) => setUserEmail(e.target.value)} onFocus={() => setSensitiveFieldFocused(true)} onBlur={() => setSensitiveFieldFocused(false)} type="email" inputMode="email" placeholder="marta@example.com" />
                  </label>
                  {userPhone.trim() !== "" && !phoneComplete && (
                    <p className="verify-hint verify-hint-warn">Enter a complete phone number (at least 10 digits).</p>
                  )}
                  {userEmail.trim() !== "" && !emailComplete && (
                    <p className="verify-hint verify-hint-warn">Enter a valid email (name@domain.com) — your receipt will be sent there.</p>
                  )}
                </div>}
              </section>

              {/* b) Biometría: Face ID / huella */}
              <section className={`verify-item is-${biometricStatus}`}>
                <header className="verify-item-heading">
                  <span className="verify-item-number" aria-hidden="true">{passkeyVerified ? "✓" : "2"}</span>
                  <div className="verify-item-title"><b>Biometrics</b><small>{passkeyVerified ? "Identity verified" : "Confirm it's you with your face or fingerprint"}</small></div>
                  <em className={`verify-chip is-${biometricStatus}`}>{verificationStatusLabel[biometricStatus]}</em>
                </header>
                {!biometricCollapsed && <div className="verify-item-body">
                  <button className="verify-action" type="button" onClick={openBiometricsModal} disabled={passkeyVerified || showBioModal}>
                    {showBioModal ? "Verifying…" : "Verify with Face ID / Fingerprint"}
                  </button>
                </div>}
              </section>

            </>}

            {currentStep === 2 && (
              <section className={`verify-item is-${tokenVerified ? "complete" : "pending"}`}>
                <header className="verify-item-heading">
                  <span className="verify-item-number" aria-hidden="true">{tokenVerified ? "✓" : "1"}</span>
                  <div className="verify-item-title"><b>DLP Token</b><small>{tokenVerified ? "Payment method protected" : "Tokenize your card: the merchant never sees the real number"}</small></div>
                  <em className={`verify-chip is-${tokenVerified ? "complete" : "pending"}`}>{tokenVerified ? "COMPLETED" : "PENDING"}</em>
                </header>
                <div className="verify-item-body">
                  <div className="sms-code-controls">
                    <input value={cardNumber} onChange={(e) => setCardNumber(e.target.value)} placeholder="•••• •••• •••• 4242" aria-label="Card number" />
                    <button className="verify-action verify-action-confirm" type="button" disabled={tokenVerified} onClick={async () => { try { const token = await handleTokenizeCard(cardNumber); if (token) setTokenVerified(true); } catch (e) { console.warn(e); } }}>
                      {tokenVerified ? "✓ Card protected" : "Tokenize card"}
                    </button>
                  </div>
                </div>
              </section>
            )}
          </div>}

          <div className="wizard-step" style={{ display: currentStep === 4 ? "grid" : "none" }}>
            <h3>Confirm and authorize</h3>
            <div className="permission-summary"><span>THIS IS WHAT YOUR PERMISSION WILL LOOK LIKE</span><p>{summary}</p></div>
          </div>

          {(error || securityError) && <div className="form-error" role="alert">{error || securityError}</div>}

          {currentStep === 1 && !stepOneReady && <p className="wizard-notice">To continue, complete your identity details and biometric verification.</p>}
          {currentStep === 2 && !tokenVerified && <p className="wizard-notice">Tokenize your secure payment method to continue.</p>}

          <div className="wizard-navigation">
            {currentStep > 1 && <button className="wizard-back" type="button" onClick={() => setCurrentStep((currentStep - 1) as 1 | 2 | 3 | 4)}>← Back</button>}
            {currentStep === 1 && <button className="wizard-next" type="button" disabled={!stepOneReady} onClick={() => setCurrentStep(2)}>Next →</button>}
            {currentStep === 2 && <button className="wizard-next" type="button" disabled={!tokenVerified} onClick={() => setCurrentStep(3)}>Next →</button>}
            {currentStep === 3 && <button className="wizard-next" type="button" onClick={() => setCurrentStep(4)}>Next →</button>}
            {currentStep === 4 && <button className="authorize-button" disabled={creating || !(passkeyVerified && tokenVerified)} type="submit">{creating ? "CREATING YOUR PERMISSION…" : !passkeyVerified ? "⚠ BIOMETRICS MISSING" : !tokenVerified ? "⚠ BANK TOKEN MISSING" : "AUTHORIZE SATURDAY"}</button>}
          </div>
        </form>
      </section>
    </main>
  );
}
