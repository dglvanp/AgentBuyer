import os
import uuid
import secrets
from datetime import datetime, timezone
from typing import Dict, Any, Optional, Tuple, List
from numbers import Real
from copy import deepcopy

from shared.schemas import (
    Mandate,
    CatalogItem,
    PurchaseAttempt,
    VerificationResult,
    EventType,
    ActorType,
)
from mandate.sign import sign_payload
from core.merchant import vuelaya_merchant, VuelaYaMerchant
from core.mandate_store import VERIFICATION_EVENTS, get_mandate
from audit.log import audit_ledger, append_entry
from core.merchant_search import _merchant_slug, search_merchant_offers


class PurchasingAgent:
    """
    Autonomous purchasing agent that discovers deals, evaluates them against active mandates,
    signs purchase attempts cryptographically, and submits them to merchants.
    """

    def __init__(self, agent_id: str, agent_privkey: str, agent_pubkey: str):
        self.agent_id = agent_id
        self.agent_privkey = agent_privkey
        self.agent_pubkey = agent_pubkey
        self.purchase_history: List[Dict[str, Any]] = []

    def create_signed_attempt(
        self,
        mandate: Mandate,
        item: CatalogItem,
        merchant_id: str,
        override_amount: Optional[float] = None,
        tampered_nonce: Optional[str] = None,
        tampered_agent_id: Optional[str] = None,
        forge_signature: bool = False,
    ) -> PurchaseAttempt:
        attempt_id = f"att_{uuid.uuid4().hex[:10]}"
        timestamp = datetime.now(timezone.utc).isoformat()
        nonce = tampered_nonce if tampered_nonce else secrets.token_hex(16)
        active_agent_id = tampered_agent_id if tampered_agent_id else self.agent_id
        amount = override_amount if override_amount is not None else item.price

        unsigned_dict: Dict[str, Any] = {
            "attempt_id": attempt_id,
            "mandate_id": mandate.mandate_id,
            "agent_id": active_agent_id,
            "merchant_id": merchant_id,
            "category": item.category,
            "amount": amount,
            "currency": item.currency,
            "timestamp": timestamp,
            "nonce": nonce,
            "item_description": getattr(item, "description", getattr(item, "title", "Vuelo")),
            "metadata": item.metadata,
        }

        if forge_signature:
            signature = "forged_signature_000000000000000000000000000000000000000000000000"
        else:
            signature = sign_payload(self.agent_privkey, unsigned_dict)

        return PurchaseAttempt(
            **unsigned_dict,
            signature=signature,
            agent_signature=signature,
        )


    def attempt_purchase(
        self,
        mandate: Mandate,
        item: CatalogItem,
        merchant: Optional[VuelaYaMerchant] = None,
        override_amount: Optional[float] = None,
        tampered_nonce: Optional[str] = None,
        tampered_agent_id: Optional[str] = None,
        forge_signature: bool = False,
    ) -> Tuple[PurchaseAttempt, VerificationResult]:
        actual_merchant = merchant if merchant is not None else vuelaya_merchant
        attempt = self.create_signed_attempt(
            mandate=mandate,
            item=item,
            merchant_id=actual_merchant.merchant_id,
            override_amount=override_amount,
            tampered_nonce=tampered_nonce,
            tampered_agent_id=tampered_agent_id,
            forge_signature=forge_signature,
        )

        from core.verify import gateway
        result = gateway.verify_and_authorize(attempt, mandate, merchant_pubkey=actual_merchant.pubkey)

        if result.authorized:
            actual_merchant.record_settlement(
                attempt_id=attempt.attempt_id,
                settlement_token=result.settlement_token,
                amount=attempt.amount,
            )

        self.purchase_history.append({
            "attempt": attempt.model_dump(),
            "result": result.model_dump(),
        })

        return attempt, result


def _category_key(mandate: dict) -> str:
    """Clave de búsqueda ('flights' | 'hotels') según la categoría del mandato."""
    constraints = mandate.get("constraints", {}) or {}
    allowed = constraints.get("allowed_categories") or []
    taxon = allowed[0] if allowed else "travel.flights"
    return "hotels" if taxon == "travel.hotels" else "flights"


def _discover_offers(category_key: str, search_fields: dict | None) -> tuple[list[dict], str]:
    """Descubre ofertas (vuelos u hoteles) SOLO con búsqueda web real.

    Si no hay campos de búsqueda o la búsqueda no devuelve ofertas, regresa
    una lista vacía: el llamador informa "no encontré ofertas" en vez de
    inventar datos de un catálogo falso.
    """
    if isinstance(search_fields, dict) and search_fields:
        offers = search_merchant_offers(category_key, search_fields)
        if offers:
            if category_key == "hotels":
                nights = search_fields.get("nights")
                label = f"{search_fields.get('destination', '?')}" + (f" · {nights} nights" if nights else "")
                taxon = "travel.hotels"
            else:
                label = f"{search_fields.get('origin', '?')}->{search_fields.get('destination', '?')}"
                taxon = "travel.flights"
            found = [
                {
                    "id": f"web_{index}",
                    # "route" es la etiqueta visible (ruta de vuelo o destino de hotel);
                    # el nombre se conserva por contrato con el frontend.
                    "route": label,
                    "price": offer["price"],
                    "category": taxon,
                    "merchant_id": _merchant_slug(offer["merchant"]),
                    "merchant": offer["merchant"],
                    "details": offer["details"],
                    "url": offer["url"],
                    "source": "web",
                }
                for index, offer in enumerate(offers)
            ]
            return found, "web"
    return [], "web"


def _price_limit(mandate: dict) -> int | float | None:
    """Lee price_below o max_amount con compatibilidad de contratos."""
    constraints = mandate.get("constraints", {}) or mandate.get("scope", {})
    conditions = constraints.get("conditions", []) if isinstance(constraints, dict) else []
    for condition in conditions:
        if isinstance(condition, dict) and condition.get("type") == "price_below":
            candidate = condition.get("value")
            if isinstance(candidate, Real) and not isinstance(candidate, bool):
                return candidate

    candidates = [
        mandate.get("price_below"),
        mandate.get("max_amount_per_purchase"),
        constraints.get("price_below") if isinstance(constraints, dict) else None,
        constraints.get("max_amount_per_purchase") if isinstance(constraints, dict) else None,
        constraints.get("max_amount_per_tx") if isinstance(constraints, dict) else None,
    ]
    for candidate in candidates:
        if isinstance(candidate, Real) and not isinstance(candidate, bool):
            return candidate
    return None


def run_agent(mandate_id: str, search_fields: dict | None = None) -> dict:
    """Descubre, decide, intenta y registra el resultado de una compra.

    Descubre ofertas REALES vía web search con search_fields ({origin,
    destination, departure_date, ...}); si el llamador no los pasa, usa los
    guardados en el mandato. Sin resultados reales NO hay compra: se informa
    "no encontré vuelos" (no existe ya un catálogo demo de respaldo).
    """
    record = get_mandate(mandate_id)
    mandate = record["mandate"] if record is not None else {}
    if not search_fields:
        stored_fields = mandate.get("search_fields")
        if isinstance(stored_fields, dict) and stored_fields:
            search_fields = stored_fields

    category_key = _category_key(mandate)
    flights_seen, discovery_source = _discover_offers(category_key, search_fields)
    limit = _price_limit(mandate)

    if not flights_seen:
        message = (
            "Saturday no encontró ofertas en este momento. "
            "No se realizó ningún intento de compra; intenta de nuevo."
        )
        append_entry(
            {
                "type": "agent_run",
                "mandate_id": mandate_id,
                "summary": "La búsqueda web no devolvió ofertas; el agente no intentó ninguna compra.",
            }
        )
        return {
            "mandate_id": mandate_id,
            "attempt_id": None,
            "discovery_source": discovery_source,
            "flights_seen": [],
            "selected_flight": None,
            "no_offers": True,
            "purchase_completed": False,
            "human_readable": message,
        }

    eligible = [flight for flight in flights_seen if limit is not None and flight["price"] <= limit]
    selected_flight = min(eligible or flights_seen, key=lambda flight: flight["price"])
    attempt_id = f"att_agent_{uuid.uuid4().hex[:12]}"
    agent_id = mandate.get("agent", {}).get("id", "agent_marta")
    
    attempt = {
        "attempt_id": attempt_id,
        "mandate_id": mandate_id,
        "presented_by_agent": agent_id,
        "purchase": {
            "merchant_id": selected_flight["merchant_id"],
            "category": selected_flight["category"],
            "amount": selected_flight["price"],
            "currency": "USD",
            "description": (f"Hotel stay: {selected_flight['route']}" if category_key == "hotels" else f"Flight {selected_flight['route']}") + (f" — {selected_flight['details']}" if selected_flight.get("details") else ""),
            "metadata": {
                "flight_id": selected_flight["id"],
                "price": selected_flight["price"],
                "source": selected_flight["source"],
                **({"url": selected_flight["url"]} if selected_flight.get("url") else {}),
            },
        },
    }

    from api.verify import verify_purchase as api_verify_purchase
    verification = api_verify_purchase(attempt)
    verdict = verification.get("verdict", "REJECT")
    completed = verdict == "APPROVE"

    VERIFICATION_EVENTS.append(
        {
            "mandate_id": mandate_id,
            "attempt_id": attempt_id,
            "verdict": verdict,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": "agent_run",
        }
    )

    story = (
        f"Encontró {len(flights_seen)} {'hoteles' if category_key == 'hotels' else 'vuelos'} en la web (búsqueda real). "
        + (f"Aplicó el límite price_below de {limit} USD y " if limit is not None else "No encontró un límite price_below utilizable y ")
        + f"eligió {selected_flight['route']} de {selected_flight.get('merchant', selected_flight['merchant_id'])} por {selected_flight['price']} USD. "
        + ("La compra fue completada tras recibir APPROVE." if completed else f"La compra no procedió: verify devolvió {verdict}. {verification.get('human_readable', '')}")
    )
    
    append_entry(
        {
            "type": "agent_run",
            "mandate_id": mandate_id,
            "attempt_id": attempt_id,
            "verdict": verdict,
            "summary": story,
        }
    )
    if completed:
        append_entry(
            {
                "type": "purchase_completed",
                "mandate_id": mandate_id,
                "attempt_id": attempt_id,
                "verdict": "APPROVE",
                "summary": f"Compra completada por Saturday: {selected_flight['route']} por {selected_flight['price']} USD.",
            }
        )
        try:
            from core.notifications import enviar_ticket_confirmacion
            # Solo el correo del titular; sin él, notifications omite el envío
            # (jamás caer a SMTP_USER: eso mandaba el recibo al propio emisor).
            user_email = mandate.get("human", {}).get("email") or ""
            enviar_ticket_confirmacion(
                correo_destino=user_email,
                detalles_reserva={
                    "destino": selected_flight.get("route", "Buenos Aires ➔ Córdoba"),
                    "proveedor": selected_flight.get("merchant", "VuelaYa Travel"),
                    "pnr": f"PNR-VYA-{attempt_id[-6:].upper()}",
                    "precio_total": selected_flight.get("price", 130),
                    "moneda": "USD",
                    "pasajero": mandate.get("human", {}).get("display_name", "Marta"),
                    "candidate_id": mandate_id,
                }
            )
        except Exception as notify_err:
            print("Aviso al enviar ticket de confirmación:", notify_err)
    return {
        "mandate_id": mandate_id,
        "attempt_id": attempt_id,
        "discovery_source": discovery_source,
        "flights_seen": flights_seen,
        "selected_flight": selected_flight,
        "selection_reason": "Vuelo más barato dentro de price_below." if eligible else "No hubo vuelo dentro de price_below; se intentó el más barato disponible.",
        "attempt": attempt,
        "verification": verification,
        "purchase_completed": completed,
        "human_readable": story,
    }
