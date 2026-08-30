/** Etiquetas humanas EN INGLÉS: el contrato interno con el backend no cambia
 * (el backend sigue emitiendo sus textos en español); esta capa de
 * presentación traduce todo lo visible para el usuario. */
export function verdictLabel(verdict?: string): string {
  switch (verdict) {
    case "APPROVE":
      return "APPROVED";
    case "ESCALATE":
      return "NEEDS APPROVAL";
    case "REJECT":
      return "REJECTED";
    default:
      return "NO VERDICT";
  }
}

export function auditTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    mandate_created: "mandate created",
    verification: "verification",
    revocation: "revocation",
    purchase_completed: "purchase completed",
    agent_run: "agent run",
    human_override_approved: "human approval",
    human_override_declined: "human decline",
    DISPUTE_FILED: "dispute filed",
    DISPUTE_RESOLVED: "dispute resolved",
  };
  return labels[type] ?? type.replace(/_/g, " ");
}

export function saturdayStateLabel(state: string): string {
  const labels: Record<string, string> = {
    idle: "STANDING BY",
    thinking: "ANALYZING",
    approve: "APPROVED",
    escalate: "NEEDS APPROVAL",
    reject: "REJECTED",
  };
  return labels[state] ?? state;
}

/** Convierte identificadores de dominio en nombres legibles, incluso dentro de textos. */
export function displayName(value: string): string {
  const exactLabels: Record<string, string> = {
    "travel.flights": "Flights",
    "travel.hotels": "Hotels",
    "subscriptions": "Subscriptions",
    "digital.subscriptions": "Subscriptions",
    "mch_vuelaya": "VuelaYa",
  };
  if (exactLabels[value]) return exactLabels[value];
  if (/^fly_vy_\d+$/.test(value)) return `Flight ${Number(value.slice(-3))}`;
  if (value.startsWith("mch_")) return value.slice(4).replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  if (value.startsWith("travel.")) return value.slice(7).replace(/\b\w/g, (letter) => letter.toUpperCase());
  if (value.startsWith("mnd_")) return `Mandate ${value.slice(4).replace(/_/g, " ")}`;

  let readable = value;
  for (const [technical, label] of Object.entries(exactLabels)) {
    readable = readable.replace(new RegExp(technical.replace(".", "\\."), "g"), label);
  }
  return readable
    .replace(/fly_vy_(\d+)/g, (_, number: string) => `Flight ${Number(number)}`)
    .replace(/travel\.([a-z_]+)/g, (_, category: string) => category.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()))
    .replace(/mch_([a-z_]+)/g, (_, merchant: string) => merchant.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()));
}

/** Diccionario español→inglés para los textos que emite el backend (resúmenes
 * de auditoría, detalles de checks, narrativa del agente, disputas, errores).
 * Se aplican en orden: frases largas primero para evitar traducciones a medias. */
const BACKEND_PHRASES: Array<[RegExp, string]> = [
  // Narrativa del agente (core/agent_loop.py)
  [/Encontró (\d+) vuelos en la web \(búsqueda real\)\./g, "Found $1 flights on the web (real search)."],
  [/Encontró (\d+) hoteles en la web \(búsqueda real\)\./g, "Found $1 hotels on the web (real search)."],
  [/Aplicó el límite price_below de ([\d.]+) USD y eligió (.+?) de (.+?) por ([\d.]+) USD\./g, "Applied the price_below limit of $1 USD and chose $2 from $3 for $4 USD."],
  [/No encontró un límite price_below utilizable y eligió (.+?) de (.+?) por ([\d.]+) USD\./g, "Did not find a usable price_below limit and chose $1 from $2 for $3 USD."],
  [/La compra fue completada tras recibir APPROVE\./g, "The purchase was completed after APPROVE."],
  [/La compra no procedió: verify devolvió (\w+)\./g, "The purchase did not proceed: verify returned $1."],
  [/Compra completada por Saturday: (.+?) por ([\d.]+) USD\./g, "Purchase completed by Saturday: $1 for $2 USD."],
  [/La búsqueda web no devolvió (?:vuelos|ofertas); el agente no intentó ninguna compra\./g, "The web search returned no offers; the agent did not attempt any purchase."],
  [/Saturday no encontró (?:vuelos|ofertas) en este momento\. No se realizó ningún intento de compra; intenta de nuevo\./g, "Saturday couldn't find offers right now. No purchase attempt was made; try again."],
  [/Vuelo más barato dentro de price_below\./g, "Cheapest flight within price_below."],
  [/No hubo vuelo dentro de price_below; se intentó el más barato disponible\./g, "No flight was within price_below; the cheapest available was attempted."],
  // Veredictos del guardián (api/verify.py)
  [/Compra aprobada por el mandato\./g, "Purchase approved by the mandate."],
  [/La compra requiere aprobación humana\./g, "The purchase requires human approval."],
  [/Requiere aprobación humana: falló /g, "Requires human approval — failed check: "],
  [/Compra rechazada: el mandato no existe\./g, "Purchase rejected: the mandate does not exist."],
  [/Compra rechazada: el mandato está revocado\./g, "Purchase rejected: the mandate is revoked."],
  [/Compra rechazada: el mandato está expirado\./g, "Purchase rejected: the mandate is expired."],
  [/Compra rechazada: el agente no coincide con el mandato\./g, "Purchase rejected: the agent does not match the mandate."],
  [/Compra rechazada: firma criptográfica inválida\./g, "Purchase rejected: invalid cryptographic signature."],
  [/Compra rechazada: la firma del mandato no es válida\./g, "Purchase rejected: the mandate signature is not valid."],
  // Detalles de checks (engine/)
  [/([\d.]+) no es menor que ([\d.]+)/g, "$1 is not below $2"],
  [/([\d.]+) excede el máximo de ([\d.]+)/g, "$1 exceeds the maximum of $2"],
  [/usos agotados \((\d+)\/(\d+)\)/g, "uses exhausted ($1/$2)"],
  [/sin límite/g, "no limit"],
  [/tipo de condición desconocido: /g, "unknown condition type: "],
  [/no está en \[/g, "is not in ["],
  [/permitida\b/g, "allowed"],
  [/permitido\b/g, "allowed"],
  [/Monto excede el máximo/g, "Amount exceeds the maximum"],
  [/Categoría no permitida/g, "Category not allowed"],
  [/Comercio no permitido/g, "Merchant not allowed"],
  [/Usos agotados/g, "Uses exhausted"],
  [/Entrada inválida/g, "Invalid input"],
  [/Error interno del motor de restricciones — rechazado por seguridad/g, "Internal constraint-engine error — rejected for safety"],
  // Firma / agente / estado (core/verify.py + api/verify.py)
  [/Firma presente y estructurada\./g, "Signature present and well-formed."],
  [/Firma presente y verificada\./g, "Signature present and verified."],
  [/Firma digital Ed25519 válida\./g, "Valid Ed25519 digital signature."],
  [/Firma digital inválida\./g, "Invalid digital signature."],
  [/Firma ausente o vacía\./g, "Signature missing or empty."],
  [/Agente autorizado\./g, "Agent authorized."],
  [/El agente que presenta el intento no está autorizado\./g, "The agent presenting the attempt is not authorized."],
  [/Mandato activo al momento de la revisión\./g, "Mandate active at the time of review."],
  [/Mandato activo\./g, "Mandate active."],
  [/Mandato no encontrado\.?/g, "Mandate not found."],
  [/mandato revocado/g, "mandate revoked"],
  [/mandato expirado/g, "mandate expired"],
  // Revisión humana (api/escalations.py)
  [/Aprobada por una persona\./g, "Approved by a person."],
  [/Rechazada por una persona\./g, "Declined by a person."],
  [/Compra aprobada por revisión humana tras la escalación\./g, "Purchase approved by human review after escalation."],
  [/Compra rechazada por revisión humana tras la escalación\./g, "Purchase declined by human review after escalation."],
  [/Escalada por (.+?) — revisada y APROBADA por una persona\./g, "Escalated for $1 — reviewed and APPROVED by a person."],
  [/Escalada por (.+?) — revisada y RECHAZADA por una persona\./g, "Escalated for $1 — reviewed and DECLINED by a person."],
  [/Este intento ya fue revisado por una persona\./g, "This attempt was already reviewed by a person."],
  [/El mandato está (mandate revoked|mandate expired|\w+): una revisión humana no puede aprobar compras sobre un mandato que ya no es válido\./g, "The mandate is $1: a human review cannot approve purchases on a mandate that is no longer valid."],
  [/Solo los intentos escalados admiten revisión humana; este quedó (\w+)\./g, "Only escalated attempts allow human review; this one was $1."],
  [/No existe una verificación registrada para ese intento en este mandato\./g, "There is no recorded verification for that attempt on this mandate."],
  [/La escalación no registró un monto verificable; no se puede aprobar\./g, "The escalation did not record a verifiable amount; it cannot be approved."],
  // Mandato / auditoría (api/main.py, core/mandate_store.py)
  [/Mandato creado para (.+?)\./g, "Mandate created for $1."],
  [/Mandato revocado por la persona autorizante\./g, "Mandate revoked by the authorizing person."],
  [/la persona autorizante/g, "the authorizing person"],
  // Disputas (api/disputes.py)
  [/Disputa (\S+) abierta por el titular: /g, "Dispute $1 filed by the cardholder: "],
  [/Disputa (\S+) resuelta: (\w+) responsable/g, "Dispute $1 resolved: $2 liable"],
  [/ — cargo válido, sin reembolso/g, " — valid charge, no refund"],
  [/ — reembolso emitido al titular\./g, " — refund issued to the cardholder."],
  [/El titular niega haber autorizado este cargo\./g, "The cardholder denies authorizing this charge."],
  [/No reconozco este cargo — el titular niega haberlo autorizado\./g, "I don't recognize this charge — the cardholder denies authorizing it."],
  [/La evidencia criptográfica del registro confirma que la compra fue verificada y aprobada dentro de un mandato activo y firmado por el titular\. La disputa se desestima\./g, "The ledger's cryptographic evidence confirms the purchase was verified and approved under an active mandate signed by the cardholder. The dispute is dismissed."],
  [/El comercio aceptó la compra \((.+?)\) DESPUÉS de que el mandato fue revocado \((.+?)\)\. El titular queda protegido\./g, "The merchant accepted the purchase ($1) AFTER the mandate was revoked ($2). The cardholder is protected."],
  [/El comercio procesó un pago contra un mandato que no existe en el registro\. El titular queda protegido\./g, "The merchant processed a payment against a mandate that does not exist in the registry. The cardholder is protected."],
  [/No existe registro de verificación ni de aprobación para esta compra en el trail auditable\. El titular queda protegido\./g, "There is no verification or approval record for this purchase in the auditable trail. The cardholder is protected."],
  [/El titular queda protegido\./g, "The cardholder is protected."],
  // OTP / errores HTTP frecuentes
  [/Código email OTP incorrecto o expirado\./g, "Incorrect or expired email OTP code."],
  [/Código SMS incorrecto o expirado\./g, "Incorrect or expired SMS code."],
  [/Código OTP enviado a /g, "OTP code sent to "],
  [/Email verificado correctamente\./g, "Email verified successfully."],
  [/Número verificado correctamente\./g, "Number verified successfully."],
];

/** Traduce el texto del backend a inglés (capa de presentación; el backend no cambia). */
export function translateBackendText(value: string): string {
  let text = value;
  for (const [pattern, replacement] of BACKEND_PHRASES) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function localizedText(value: string): string {
  return displayName(translateBackendText(value))
    .replace(/\bAPPROVE\b/g, verdictLabel("APPROVE"))
    .replace(/\bESCALATE\b/g, verdictLabel("ESCALATE"))
    .replace(/\bREJECT\b/g, verdictLabel("REJECT"));
}

/** Ajusta la redacción de los checks sin alterar el valor técnico que entregó el motor. */
export function checkDetailLabel(rule: string, detail: string): string {
  if (rule === "category") {
    const technicalCategory = detail.split(" ")[0];
    const category = displayName(technicalCategory);
    if (detail.includes("permitida")) return `${category} allowed`;
    if (detail.includes("no está")) return `${category} is not an allowed category`;
  }
  if (rule === "merchant") {
    const technicalMerchant = detail.split(" ")[0];
    const merchant = displayName(technicalMerchant);
    if (detail.includes("permitido")) return `${merchant} authorized`;
    if (detail.includes("no está")) return `${merchant} is not an authorized merchant`;
  }
  return localizedText(detail);
}

export function checkRuleLabel(rule: string): string {
  const labels: Record<string, string> = {
    mandate_exists: "Mandate exists",
    signature: "Signature",
    agent_identity: "Agent identity",
    status: "Mandate status",
    amount: "Amount",
    category: "Category",
    merchant: "Merchant",
    uses: "Uses remaining",
    "condition.price_below": "Price condition",
    "engine.internal_error": "Engine error",
  };
  return labels[rule] ?? displayName(rule);
}
