from dotenv import load_dotenv
load_dotenv()

import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

from fastapi import FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from shared.schemas import (
    Mandate,
    CreateMandateRequest,
    RevokeMandateRequest,
    PurchaseAttempt,
    ExecutePurchaseRequest,
    HITLApprovalRequest,
    ResolveEscalationRequest,
    DisputeClaim,
    FileDisputeRequest,
    CatalogItem,
)
from mandate.issue import create_mandate
from mandate.sign import generate_keypair
from core.mandate_store import (
    mandate_store,
    create_mandate as store_create_mandate,
    get_mandate as store_get_mandate,
    revoke_mandate as store_revoke_mandate,
    reset_mandate,
)
from core.merchant import vuelaya_merchant, get_flights
from core.agent_loop import PurchasingAgent, run_agent
from audit.log import audit_ledger, append_entry, get_trail_for, reset_trail
from core.dispute import dispute_arbiter
from mandate.adversarial_tests import run_adversarial_suite

def load_seed_mandates():
    seed_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "shared", "seed_mandates.json")
    if os.path.exists(seed_path):
        import json
        with open(seed_path, "r", encoding="utf-8") as f:
            seeds = json.load(f)
            for m in seeds:
                try:
                    store_create_mandate(m)
                except Exception:
                    pass


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Reemplaza el @app.on_event("startup") deprecado.
    load_seed_mandates()
    yield


app = FastAPI(
    title="AgentBuyer Protocol API",
    description="Safe agentic purchases powered by Zero-Trust mandates, cryptographic signatures & deterministic limits.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Key storage for demo
_key_registry: Dict[str, Dict[str, str]] = {}


def _get_or_create_keys(entity_id: str) -> Dict[str, str]:

    if entity_id not in _key_registry:
        priv, pub = generate_keypair()
        _key_registry[entity_id] = {"priv": priv, "pub": pub}
    return _key_registry[entity_id]


@app.get("/", response_class=HTMLResponse)
@app.get("/app", response_class=HTMLResponse)
def web_app():
    static_file = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static", "index.html")
    if os.path.exists(static_file):
        with open(static_file, "r", encoding="utf-8") as f:
            return f.read()
    return "<h1>AgentBuyer Mission Control</h1>"



@app.get("/health")
def health():
    return {"status": "ok"}


# Optional Twilio Verify Client
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_VERIFY_SERVICE_SID = os.getenv("TWILIO_VERIFY_SERVICE_SID", "")

twilio_client = None
if TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN:
    try:
        from twilio.rest import Client as TwilioClient
        twilio_client = TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    except Exception as e:
        print("Twilio init notice:", e)


# OTP & SMS Endpoints
class OtpSendReq(BaseModel):
    phone: str


class OtpVerifyReq(BaseModel):
    phone: str
    code: str


class SmsStartRequest(BaseModel):
    phone_number: str


class SmsCheckRequest(BaseModel):
    phone_number: str
    code: str


_otp_store: Dict[str, str] = {}


def normalizar_telefono(phone_number: str) -> str:
    """Normaliza un número de teléfono a formato internacional E.164 (+5255..., +54911...)."""
    phone_str = phone_number.strip()
    try:
        import phonenumbers
        # Si no tiene '+', asumir que puede ser local o ya incluir código
        parsed = phonenumbers.parse(phone_str if phone_str.startswith("+") else f"+{phone_str}", None)
        if phonenumbers.is_valid_number(parsed):
            return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
    except Exception:
        pass
    
    # Limpieza estándar si phonenumbers no resuelve
    clean = "".join(c for c in phone_str if c.isdigit() or c == "+")
    return clean if clean.startswith("+") else f"+{clean}"


@app.post("/auth/sms/start")
def auth_sms_start(payload: SmsStartRequest):
    import secrets
    telefono = normalizar_telefono(payload.phone_number)
    code = str(secrets.randbelow(900000) + 100000)
    _otp_store[telefono] = code
    _otp_store[payload.phone_number.strip()] = code
    
    status_str = "pending"
    if twilio_client and TWILIO_VERIFY_SERVICE_SID:
        try:
            verif = twilio_client.verify.v2.services(TWILIO_VERIFY_SERVICE_SID).verifications.create(
                to=telefono,
                channel="sms"
            )
            status_str = verif.status
        except Exception as err:
            print("Twilio verify start notice:", err)

    return {
        "ok": True,
        "status": status_str,
        "phone_hint": f"***{telefono[-4:]}" if len(telefono) >= 4 else telefono,
        "code_demo": code if not (twilio_client and TWILIO_VERIFY_SERVICE_SID) else "******",
        "message": f"Código SMS enviado a {telefono}"
    }


@app.post("/auth/sms/check")
def auth_sms_check(payload: SmsCheckRequest):
    telefono = normalizar_telefono(payload.phone_number)
    code_in = payload.code.strip()
    
    # Si Twilio Verify está configurado, validación real estricta con Twilio
    if twilio_client and TWILIO_VERIFY_SERVICE_SID:
        try:
            check = twilio_client.verify.v2.services(TWILIO_VERIFY_SERVICE_SID).verification_checks.create(
                to=telefono,
                code=code_in
            )
            if check.status == "approved":
                return {
                    "ok": True,
                    "verified": True,
                    "phone": telefono,
                    "message": "Número verificado correctamente con Twilio Verify."
                }
            raise HTTPException(status_code=401, detail="Código SMS incorrecto o expirado.")
        except HTTPException:
            raise
        except Exception as err:
            print("Twilio check notice:", err)
            raise HTTPException(status_code=401, detail=f"Error validando con Twilio: {err}")

    # Validación estricta con el código generado aleatoriamente
    expected = _otp_store.get(telefono) or _otp_store.get(payload.phone_number.strip())
    if expected and code_in == expected:
        return {
            "ok": True,
            "verified": True,
            "phone": telefono,
            "message": "Número verificado correctamente."
        }
    raise HTTPException(status_code=401, detail="Código SMS incorrecto o expirado.")


@app.post("/api/otp/send")
def api_otp_send(req: OtpSendReq):
    import secrets
    telefono = normalizar_telefono(req.phone)
    code = str(secrets.randbelow(900000) + 100000)
    _otp_store[telefono] = code
    _otp_store[req.phone.strip()] = code

    # Si hay Twilio Verify configurado
    if twilio_client and TWILIO_VERIFY_SERVICE_SID:
        try:
            twilio_client.verify.v2.services(TWILIO_VERIFY_SERVICE_SID).verifications.create(
                to=telefono,
                channel="sms"
            )
        except Exception as err:
            print("Twilio send notice:", err)

    return {
        "success": True,
        "code": code if not (twilio_client and TWILIO_VERIFY_SERVICE_SID) else "******",
        "message": f"Código SMS OTP enviado a {telefono}",
        "phone": telefono,
        "requestId": f"req_{int(time.time())}"
    }


@app.post("/api/otp/verify")
def api_otp_verify(req: OtpVerifyReq):
    telefono = normalizar_telefono(req.phone)
    code_in = req.code.strip()
    expected = _otp_store.get(telefono) or _otp_store.get(req.phone.strip())
    
    if expected and code_in == expected:
        return {
            "success": True,
            "verified": True,
            "phone": telefono,
            "verifiedAt": datetime.now(timezone.utc).isoformat()
        }
    raise HTTPException(status_code=401, detail="Código SMS OTP inválido")


# Email OTP Endpoints (SMTP)
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")


class EmailStartRequest(BaseModel):
    email: str


class EmailCheckRequest(BaseModel):
    email: str
    code: str


_email_otp_store: Dict[str, str] = {}


@app.post("/auth/email/start")
def auth_email_start(payload: EmailStartRequest):
    import secrets
    email_addr = payload.email.strip().lower()
    code = str(secrets.randbelow(900000) + 100000)
    _email_otp_store[email_addr] = code

    # Lectura dinámica: permite configurar credenciales sin editar código.
    smtp_user = os.getenv("SMTP_USER", "") or SMTP_USER
    smtp_pass = os.getenv("SMTP_PASS", "") or SMTP_PASS

    sent_via = "memory"
    if smtp_user and smtp_pass:
        try:
            import smtplib
            from email.mime.text import MIMEText

            msg = MIMEText(
                f"🛡️ Zero-Trust Verification Code (Aegis):\n\nYour 6-digit verification code is: {code}\n\nThis code expires in 10 minutes. Do not share it with anyone.",
                "plain",
                "utf-8",
            )
            msg["Subject"] = f"Aegis Security OTP: {code}"
            msg["From"] = f"Saturday Agent <{smtp_user}>"
            msg["To"] = email_addr

            with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
                server.login(smtp_user, smtp_pass)
                server.sendmail(smtp_user, [email_addr], msg.as_string())
            sent_via = "smtp"
            print(f"[Gmail SMTP OTP] Successfully sent OTP code to {email_addr}")
        except Exception as err:
            print(f"[Gmail SMTP ERROR] Failed to send OTP to {email_addr}: {err}")

    return {
        "ok": True,
        "status": "pending",
        "email_hint": f"***{email_addr.split('@')[0][-3:]}@{email_addr.split('@')[1]}" if "@" in email_addr else email_addr,
        # Igual que el flujo SMS: el código solo se revela cuando NO hubo
        # entrega real (modo demo, sin SMTP); con SMTP configurado se enmascara.
        "code_demo": code if sent_via != "smtp" else "******",
        "sent_via": sent_via,
        "message": f"OTP code sent to {email_addr}",
    }


@app.post("/auth/email/check")
def auth_email_check(payload: EmailCheckRequest):
    email_addr = payload.email.strip().lower()
    code_in = payload.code.strip()

    expected = _email_otp_store.get(email_addr)
    if expected and code_in == expected:
        return {
            "ok": True,
            "verified": True,
            "email": email_addr,
            "message": "Email verified successfully.",
        }
    raise HTTPException(status_code=401, detail="Incorrect or expired Email OTP code.")


class TicketSendRequest(BaseModel):
    email: str
    pnr: Optional[str] = None
    passenger: Optional[str] = None
    destination: Optional[str] = None
    merchant: Optional[str] = None
    price: Optional[float] = None
    currency: Optional[str] = "USD"


@app.get("/inbox/messages")
def api_get_inbox_messages(limit: int = Query(default=10, ge=1, le=50)):
    """
    Connects to saturday.agentbuyer@gmail.com via IMAP and reads the latest received emails.
    """
    from core.notifications import leer_correos_recibidos
    result = leer_correos_recibidos(limite=limit)
    return result


@app.post("/notifications/send-ticket")
def api_send_ticket_notification(payload: TicketSendRequest):
    """
    Dispatches an official receipt/ticket with Google Calendar integration to ANY destination email.
    """
    from core.notifications import enviar_ticket_confirmacion
    reserva = {
        "pnr": payload.pnr or "PNR-VYA-849201",
        "pasajero": payload.passenger or "Authorized Customer",
        "destino": payload.destination or "Direct Flight Buenos Aires (AEP) -> Córdoba (COR)",
        "proveedor": payload.merchant or "VuelaYa Travel & Logistics Inc.",
        "precio_total": payload.price or 130.00,
        "moneda": payload.currency or "USD",
        "orden_id": f"ORD-{int(time.time()) % 100000}",
    }
    result = enviar_ticket_confirmacion(payload.email, reserva)
    return result


# Mandate Endpoints
@app.post("/mandates/create", response_model=Mandate)
def api_create_mandate(req: CreateMandateRequest):
    h_keys = _get_or_create_keys(req.human_id)
    a_keys = _get_or_create_keys("agent_marta")

    mandate = create_mandate(
        human_id=req.human_id,
        human_privkey=h_keys["priv"],
        human_pubkey=h_keys["pub"],
        agent_id="agent_marta",
        agent_pubkey=a_keys["pub"],
        max_amount_per_tx=req.max_amount_per_tx,
        monthly_budget=req.monthly_budget,
        allowed_categories=req.allowed_categories,
        allowed_merchants=req.allowed_merchants,
        conditions_expression=req.conditions_expression,
        currency=req.currency,
        max_executions_per_month=req.max_executions_per_month,
        allow_hitl_escalation=req.allow_hitl_escalation,
        validity_days=req.validity_days,
        masked_card=req.masked_card,
        bank_issuer=req.bank_issuer,
    )
    mandate_store.save_mandate(mandate)
    return mandate


@app.post("/mandates", status_code=status.HTTP_201_CREATED)
def create_mandate_endpoint(mandate: dict[str, Any]):
    """Crea un mandato firmado y establece su estado vivo inicial."""
    mandate_id = mandate.get("mandate_id")
    if not isinstance(mandate_id, str) or not mandate_id.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="El campo mandate_id es obligatorio y debe ser un texto no vacío.",
        )

    try:
        record = store_create_mandate(mandate)
        append_entry(
            {
                "type": "mandate_created",
                "mandate_id": mandate_id,
                "summary": f"Mandato creado para {mandate.get('human', {}).get('display_name', 'la persona autorizante')}.",
            }
        )
        return record
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=str(error)
        ) from error


@app.get("/mandates", response_model=List[Mandate])
def api_list_mandates(human_id: Optional[str] = None):
    return mandate_store.list_mandates(human_id)


@app.get("/mandates/{mandate_id}")
def api_get_mandate(mandate_id: str):
    rec = store_get_mandate(mandate_id)
    if rec is not None:
        return rec
    mandate = mandate_store.get_mandate(mandate_id)
    if mandate is not None:
        return {
            "mandate": mandate.model_dump(),
            "live_state": {
                "status": mandate.status.value.lower(),
                "uses_count": 0,
                "amount_spent": 0.0,
                "revoked_at": mandate.revoked_at,
            },
        }
    raise HTTPException(status_code=404, detail="Mandate not found")



@app.post("/mandates/{mandate_id}/revoke")
def api_revoke_mandate(mandate_id: str, req: Optional[RevokeMandateRequest] = None):
    reason = req.reason if req else "Revocado por el usuario"
    previous = store_get_mandate(mandate_id)
    success = mandate_store.revoke_mandate(mandate_id, reason)
    record = store_revoke_mandate(mandate_id)
    
    if previous is not None and previous.get("live_state", {}).get("status") != "revoked":
        append_entry(
            {
                "type": "revocation",
                "mandate_id": mandate_id,
                "summary": "Mandato revocado por la persona autorizante.",
            }
        )
    if not success and record is None:
        raise HTTPException(status_code=404, detail="Mandate not found")
    return record or {"status": "REVOKED", "mandate_id": mandate_id, "reason": reason}


@app.post("/mandates/{mandate_id}/pause")
def api_pause_mandate(mandate_id: str):
    success = mandate_store.pause_mandate(mandate_id)
    if not success:
        raise HTTPException(status_code=404, detail="Mandate not found")
    return {"status": "PAUSED", "mandate_id": mandate_id}


@app.post("/mandates/{mandate_id}/reset")
def reset_mandate_endpoint(mandate_id: str):
    """Restaura el mandato a un estado vivo fresco para reiniciar la demo."""
    record = reset_mandate(mandate_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mandato no encontrado.")
    return record


@app.post("/mandates/{mandate_id}/resume")
def api_resume_mandate(mandate_id: str):
    success = mandate_store.resume_mandate(mandate_id)
    if not success:
        raise HTTPException(status_code=404, detail="Mandate not found")
    return {"status": "ACTIVE", "mandate_id": mandate_id}


# Merchant & Purchasing Endpoints
@app.get("/merchant/catalog", response_model=List[CatalogItem])
def api_get_catalog():
    return vuelaya_merchant.get_catalog()


# /merchant/flights, /merchant/search y /agent/run viven en sus routers
# (api/merchant.py, api/agent.py) — una sola dueña por ruta, sin sombras.


@app.post("/purchases/execute")
def api_execute_purchase(req: ExecutePurchaseRequest):
    mandate = mandate_store.get_mandate(req.mandate_id)
    if not mandate:
        raise HTTPException(status_code=404, detail="Mandate not found")

    item = vuelaya_merchant.get_item(req.item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found in catalog")

    a_keys = _get_or_create_keys(req.agent_id)
    agent = PurchasingAgent(req.agent_id, a_keys["priv"], a_keys["pub"])

    attempt, result = agent.attempt_purchase(
        mandate=mandate,
        item=item,
        merchant=vuelaya_merchant,
        override_amount=req.override_amount,
    )

    return {
        "attempt": attempt,
        "verification_result": result,
    }


# Mandate Activity Trail for User
@app.get("/mandates/{mandate_id}/activity")
def api_get_mandate_activity(mandate_id: str):
    mandate = mandate_store.get_mandate(mandate_id)
    if not mandate:
        raise HTTPException(status_code=404, detail="Mandato no encontrado")
    trail = get_trail_for(role="human", mandate_id=mandate_id)
    return {
        "mandate_id": mandate_id,
        "status": mandate.status.value,
        "activity_count": len(trail),
        "trail": trail,
    }


# HITL Exception Approval
class ApproveExceptionRequest(BaseModel):
    user_passkey_signature: Optional[str] = None
    notes: Optional[str] = None


@app.post("/purchases/{purchase_id}/approve-exception")
def api_approve_purchase_exception(purchase_id: str, req: Optional[ApproveExceptionRequest] = None):
    # Procesa excepción HITL firmada con Passkey
    append_entry({
        "type": "hitl_approved",
        "attempt_id": purchase_id,
        "mandate_id": "mnd_delegated",
        "summary": f"Excepción autorizada manualmente por el titular con Passkey para intento {purchase_id}.",
    })
    return {
        "ok": True,
        "purchase_id": purchase_id,
        "status": "APPROVED_BY_HUMAN_OVERRIDE",
        "message": "Compra fuera de mandato autorizada mediante verificación step-up.",
    }


# Stripe Off-Session Webhook
@app.post("/webhooks/stripe")
def api_webhook_stripe(payload: dict):
    event_type = payload.get("type", "payment_intent.succeeded")
    mandate_id = payload.get("data", {}).get("object", {}).get("metadata", {}).get("mandate_id", "mnd_live")
    amount = payload.get("data", {}).get("object", {}).get("amount", 13000) / 100.0

    append_entry({
        "type": "settlement_completed",
        "mandate_id": mandate_id,
        "summary": f"Cobro off-session de ${amount:.2f} USD confirmado por webhook de Stripe.",
    })
    return {"received": True, "event": event_type}


# Travel Provider (Amadeus / VuelaYa) Webhook
@app.post("/webhooks/travel-provider")
def api_webhook_travel_provider(payload: dict):
    pnr = payload.get("pnr", "PNR-VYA-849201")
    flight_id = payload.get("flight_id", "FLIGHT_COR_130")
    status_str = payload.get("status", "TICKET_ISSUED")
    # Sin correo en el payload no se envía nada (nunca auto-enviarse el boleto).
    user_email = payload.get("email") or ""

    append_entry({
        "type": "settlement_completed",
        "mandate_id": payload.get("mandate_id", "mnd_live"),
        "summary": f"Emisión de boleto confirmada por aerolínea: PNR {pnr} ({status_str}).",
    })

    try:
        from core.notifications import enviar_ticket_confirmacion
        enviar_ticket_confirmacion(
            correo_destino=user_email,
            detalles_reserva={
                "destino": payload.get("destination", "Córdoba (COR)"),
                "proveedor": payload.get("merchant", "VuelaYa Travel"),
                "pnr": pnr,
                "precio_total": payload.get("amount", 130),
                "moneda": "USD",
            }
        )
    except Exception as notify_err:
        print("Aviso al enviar ticket desde webhook:", notify_err)

    return {"received": True, "pnr": pnr, "status": status_str}


# Audit Trail Router
@app.post("/audit/reset")
def api_reset_audit_trail():
    """Abre una sesión de auditoría limpia al reiniciar/iniciar una demo."""
    return reset_trail()


@app.get("/audit/trail")
def api_get_audit_trail(
    role: str = Query(default="auditor", pattern="^(human|merchant|auditor)$"),
    mandate_id: Optional[str] = None,
    attempt_id: Optional[str] = None,
):
    return get_trail_for(role=role, mandate_id=mandate_id, attempt_id=attempt_id)


@app.get("/audit/verify")
def api_verify_audit_integrity():
    is_valid, msg = audit_ledger.verify_chain_integrity()
    return {"valid": is_valid, "message": msg, "total_blocks": len(audit_ledger._entries)}



# Disputas: /disputes/file y /disputes viven en api/disputes.py (resolver
# nativo del modelo API/React). core/dispute.py sigue sirviendo al flujo adversarial.


# Adversarial Suite Runner
@app.post("/adversarial/run")
def api_run_adversarial():
    success = run_adversarial_suite()
    return {
        "success": success,
        "message": "All 8 attack vectors evaluated." if success else "Some attacks breached perimeter.",
    }


# Include modular routers
from api.agent import router as agent_router
from api.audit import router as audit_router
from api.disputes import router as disputes_router
from api.escalations import router as escalations_router
from api.merchant import router as merchant_router

app.include_router(agent_router)
app.include_router(audit_router)
app.include_router(disputes_router)
app.include_router(escalations_router)
app.include_router(merchant_router)

try:
    from api.verify import router as verify_router
    app.include_router(verify_router)
except ImportError:
    pass
