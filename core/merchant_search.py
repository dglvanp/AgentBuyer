"""Búsqueda real de ofertas en comercios vía OpenAI web search.

Reemplaza el feed de precios mockeado (core/merchant.py) en el paso de
descubrimiento del agente (core/agent_loop.py):

    ofertas = search_merchant_offers("flights", {...})        # web real
    attempt = offer_to_attempt(oferta, "flights", mandate_id, agent_id)
    POST /verify con attempt  ->  verify + engine deciden como siempre

Cada oferta devuelta se convierte con offer_to_attempt() en el dict de intento
que api/verify.py ya consume (con "purchase" anidado) — el pipeline de
verificación no cambia en nada.

Nunca lanza excepciones hacia el caller: ante cualquier falla (API caída,
JSON malformado, categoría desconocida) devuelve [] y deja el detalle en el log.

Requiere OPENAI_API_KEY en .env (cargado con python-dotenv).
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

OFFER_KEYS = {"merchant", "price", "currency", "details", "url"}

# Qué campos pide cada categoría y en qué comercios se busca.
CATEGORY_SPECS: dict[str, dict[str, Any]] = {
    "flights": {
        "required": ["origin", "destination", "departure_date"],
        "optional": ["return_date", "passengers"],
        "merchants": ["Despegar", "Expedia", "Kayak"],
    },
    "hotels": {
        "required": ["destination", "check_in", "check_out"],
        "optional": ["guests", "room_type", "nights"],
        # Los mismos sitios de viaje que vuelos: sus slugs (mch_despegar, etc.)
        # ya están en allowed_merchants de los mandatos de viaje.
        "merchants": ["Despegar", "Expedia", "Kayak"],
    },
    "subscriptions": {
        # Sin comparación de comercios: solo el sitio directo del proveedor.
        "required": ["service_name"],
        "optional": ["plan_tier"],
        "merchants": [],
    },
    "tickets": {
        # Nada es estrictamente requerido, pero artist O event_date debe venir.
        "required": [],
        "optional": ["artist", "event_date", "city"],
        "merchants": ["Ticketmaster", "StubHub", "Eventbrite"],
    },
    "trains": {
        "required": ["origin", "destination", "travel_date"],
        "optional": ["preferred_time"],
        "merchants": ["Trainline"],
    },
}

# Mapeo al taxón de categorías que usan los mandatos (allowed_categories).
CATEGORY_TAXONOMY = {
    "flights": "travel.flights",
    "hotels": "travel.hotels",
    "subscriptions": "subscriptions",
    "tickets": "events.tickets",
    "trains": "travel.trains",
}

_JSON_INSTRUCTIONS = (
    "Respond with STRICT JSON only — no prose, no markdown fences. "
    'A JSON array of objects, each exactly: {"merchant": str, "price": float, '
    '"currency": str (ISO 4217, e.g. "USD"), "details": str (one short line: '
    'what the offer is), "url": str (direct link to the offer)}. '
    "Return ALL prices in USD (converted if the merchant lists another currency) "
    'and set "currency" to "USD". '
    "Prices must be numbers, not strings. If you find nothing, return []."
)


def _validate_fields(category: str, fields: dict) -> str | None:
    """Devuelve un mensaje de error o None si los campos alcanzan para buscar."""
    spec = CATEGORY_SPECS.get(category)
    if spec is None:
        return f"categoría desconocida: {category!r} (válidas: {sorted(CATEGORY_SPECS)})"
    missing = [f for f in spec["required"] if not fields.get(f)]
    if missing:
        return f"faltan campos requeridos para {category}: {missing}"
    if category == "tickets" and not (fields.get("artist") or fields.get("event_date")):
        return "tickets requiere al menos artist o event_date"
    return None


def _build_prompt(category: str, fields: dict, max_results: int) -> str:
    spec = CATEGORY_SPECS[category]
    optional_bits = ", ".join(
        f"{name}={fields[name]}" for name in spec["optional"] if fields.get(name)
    )
    extra = f" Additional preferences: {optional_bits}." if optional_bits else ""

    if category == "flights":
        base = (
            f"Search for real, currently listed airline flights from {fields['origin']} to "
            f"{fields['destination']} departing on or near {fields['departure_date']} on "
            f"{', '.join(spec['merchants'])}. Interpret 3-letter IATA/city codes (e.g. BUE, MEX, "
            f"COR) and full city names alike. Return up to {max_results} of the cheapest available "
            f"fares you can find for this route. If fares for the exact date are unavailable, return "
            f"representative current fares for the same route rather than an empty list."
        )
    elif category == "hotels":
        base = (
            f"Search for hotels in {fields['destination']} from {fields['check_in']} "
            f"to {fields['check_out']} on {', '.join(spec['merchants'])}. "
            f"Return the {max_results} cheapest results."
        )
    elif category == "subscriptions":
        service = fields["service_name"]
        tier = fields.get("plan_tier")
        base = (
            f"Search the official {service} website for its current subscription price"
            + (f" for the {tier} plan" if tier else "")
            + ". Do NOT compare across merchants — only the direct provider's "
            "currently listed price. Return exactly 1 result."
        )
    elif category == "tickets":
        what = " ".join(
            str(fields[k]) for k in ("artist", "event_date", "city") if fields.get(k)
        )
        base = (
            f"Search for event tickets: {what} on {', '.join(spec['merchants'])}. "
            f"Return the {max_results} cheapest currently purchasable results."
        )
    else:  # trains
        base = (
            f"Search for train tickets from {fields['origin']} to {fields['destination']} "
            f"on {fields['travel_date']} on {', '.join(spec['merchants'])}. "
            f"Return the {max_results} cheapest results."
        )
    return f"{base}{extra}\n\n{_JSON_INSTRUCTIONS}"


def _call_web_search(prompt: str) -> str:
    """Única frontera con la API de OpenAI — los tests mockean esta función."""
    from openai import OpenAI

    client = OpenAI()  # lee OPENAI_API_KEY del entorno (.env ya cargado)
    response = client.responses.create(
        model=os.environ.get("OPENAI_MODEL", "gpt-5.6"),
        tools=[{"type": "web_search"}],
        input=prompt,
    )
    return response.output_text


def _parse_offers(raw: str, max_results: int) -> list[dict]:
    """Parseo defensivo: fences de markdown, prosa alrededor, items inválidos."""
    text = raw.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()
    if not text.startswith("["):
        start, end = text.find("["), text.rfind("]")
        if start == -1 or end <= start:
            logger.warning("merchant_search: la respuesta no contiene un array JSON: %.200s", raw)
            return []
        text = text[start : end + 1]

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        logger.warning("merchant_search: JSON inválido (%s): %.200s", exc, raw)
        return []
    if not isinstance(data, list):
        logger.warning("merchant_search: se esperaba una lista, llegó %s", type(data).__name__)
        return []

    offers: list[dict] = []
    for item in data:
        if not isinstance(item, dict) or not OFFER_KEYS.issubset(item):
            logger.warning("merchant_search: oferta descartada por shape inválido: %r", item)
            continue
        try:
            price = float(item["price"])
        except (TypeError, ValueError):
            logger.warning("merchant_search: precio no numérico descartado: %r", item.get("price"))
            continue
        offers.append(
            {
                "merchant": str(item["merchant"]),
                "price": price,
                "currency": str(item["currency"]).upper(),
                "details": str(item["details"]),
                "url": str(item["url"]),
            }
        )
    return offers[:max_results]


def search_merchant_offers(category: str, fields: dict, max_results: int = 3) -> list[dict]:
    """Busca ofertas reales para la categoría usando OpenAI web search.

    Devuelve [{"merchant": str, "price": float, "currency": str,
    "details": str, "url": str}, ...] — siempre una lista, nunca lanza.
    """
    try:
        if not isinstance(fields, dict):
            logger.warning("merchant_search: fields debe ser dict, llegó %s", type(fields).__name__)
            return []
        error = _validate_fields(category, fields)
        if error:
            logger.warning("merchant_search: %s", error)
            return []

        effective_max = 1 if category == "subscriptions" else max_results
        raw = _call_web_search(_build_prompt(category, fields, effective_max))
        return _parse_offers(raw, effective_max)
    except Exception:  # frontera del sistema: jamás romper el loop del agente
        logger.exception("merchant_search: búsqueda falló para %r", category)
        return []


def _merchant_slug(merchant: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", merchant.lower()).strip("_") or "desconocido"
    return f"mch_{slug}"


def offer_to_attempt(
    offer: dict,
    category: str,
    mandate_id: str,
    agent_id: str,
    attempt_id: str,
) -> dict:
    """Convierte una oferta en el intento que api/verify.py ya consume."""
    return {
        "attempt_id": attempt_id,
        "mandate_id": mandate_id,
        "presented_by_agent": agent_id,
        "purchase": {
            "merchant_id": _merchant_slug(offer["merchant"]),
            "category": CATEGORY_TAXONOMY.get(category, category),
            "amount": offer["price"],
            "currency": offer["currency"],
            "description": offer["details"],
            "metadata": {"price": offer["price"], "url": offer["url"]},
        },
    }
