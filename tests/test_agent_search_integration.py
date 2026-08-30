"""Integración del descubrimiento real: /merchant/search y /agent/run con
search_fields. La red SIEMPRE va mockeada (se parcha _call_web_search)."""
import json

import pytest
from fastapi.testclient import TestClient

from api.main import app
from audit.log import AUDIT_TRAIL
from core import mandate_store, merchant_search

WEB_OFFERS = [
    {"merchant": "Despegar", "price": 55.95, "currency": "USD",
     "details": "Aeromexico NLU-CUN directo", "url": "https://despegar.example/1"},
    {"merchant": "Kayak", "price": 54.71, "currency": "USD",
     "details": "Aeromexico MEX-CUN 22:00", "url": "https://kayak.example/2"},
]

SEARCH_FIELDS = {"origin": "MEX", "destination": "CUN", "departure_date": "2026-09-15"}


@pytest.fixture()
def client():
    with TestClient(app) as test_client:
        mandate_store.MANDATES.clear()
        AUDIT_TRAIL.clear()
        yield test_client
    mandate_store.MANDATES.clear()
    AUDIT_TRAIL.clear()


def web_mandate(allowed_merchants: list[str]) -> dict:
    return {
        "mandate_id": "mnd_web_001",
        "human": {"id": "hum_test", "name": "Test"},
        "agent": {"id": "agt_test"},
        "constraints": {
            "max_amount_per_purchase": 150.00,
            "allowed_categories": ["travel.flights"],
            "allowed_merchants": allowed_merchants,
            "max_uses": 3,
            "conditions": [{"type": "price_below", "value": 150.00}],
        },
        "signature": "firma-de-prueba",
    }


def test_merchant_search_endpoint_returns_offers(client, monkeypatch):
    monkeypatch.setattr(merchant_search, "_call_web_search", lambda p: json.dumps(WEB_OFFERS))
    response = client.post("/merchant/search", json={"category": "flights", "fields": SEARCH_FIELDS})
    assert response.status_code == 200
    offers = response.json()
    assert len(offers) == 2 and offers[0]["merchant"] == "Despegar"


def test_merchant_search_endpoint_validates_body(client):
    assert client.post("/merchant/search", json={"category": "yates", "fields": {}}).status_code == 422
    assert client.post("/merchant/search", json={"category": "flights", "fields": "x"}).status_code == 422
    assert client.post(
        "/merchant/search", json={"category": "flights", "fields": SEARCH_FIELDS, "max_results": 99}
    ).status_code == 422


def test_agent_run_uses_web_offers_when_search_fields_present(client, monkeypatch):
    monkeypatch.setattr(merchant_search, "_call_web_search", lambda p: json.dumps(WEB_OFFERS))
    client.post("/mandates", json=web_mandate(["mch_despegar", "mch_kayak"]))

    result = client.post(
        "/agent/run", json={"mandate_id": "mnd_web_001", "search_fields": SEARCH_FIELDS}
    ).json()

    assert result["discovery_source"] == "web"
    assert result["purchase_completed"] is True
    # Eligió la más barata de las ofertas web reales, no del catálogo mock.
    assert result["selected_flight"]["merchant_id"] == "mch_kayak"
    assert result["selected_flight"]["price"] == 54.71
    assert result["attempt"]["purchase"]["metadata"]["source"] == "web"


def test_agent_run_reports_no_offers_when_search_fails(client, monkeypatch):
    """Sin catálogo demo de respaldo: si la búsqueda falla, NO se inventa nada."""
    def broken(prompt):
        raise RuntimeError("sin red")

    monkeypatch.setattr(merchant_search, "_call_web_search", broken)
    client.post("/mandates", json=web_mandate(["mch_vuelaya"]))

    result = client.post(
        "/agent/run", json={"mandate_id": "mnd_web_001", "search_fields": SEARCH_FIELDS}
    ).json()

    assert result["no_offers"] is True
    assert result["selected_flight"] is None
    assert result["flights_seen"] == []
    assert result["purchase_completed"] is False


def test_agent_run_without_search_fields_reports_no_offers(client):
    """Sin campos de búsqueda (ni en el request ni en el mandato) no hay red
    que consultar → no hay vuelos ni intento, nunca datos falsos."""
    client.post("/mandates", json=web_mandate(["mch_vuelaya"]))
    result = client.post("/agent/run", json={"mandate_id": "mnd_web_001"}).json()
    assert result["no_offers"] is True
    assert result["selected_flight"] is None
    assert result["purchase_completed"] is False


HOTEL_OFFERS = [
    {"merchant": "Expedia", "price": 89.0, "currency": "USD",
     "details": "Hotel Azur Real — Centro, desayuno incluido", "url": "https://expedia.example/h1"},
    {"merchant": "Despegar", "price": 74.5, "currency": "USD",
     "details": "Amérian Córdoba Park Hotel", "url": "https://despegar.example/h2"},
]

HOTEL_FIELDS = {"destination": "Cordoba, Argentina", "check_in": "2026-09-15", "check_out": "2026-09-18", "nights": 3}


def hotel_mandate() -> dict:
    mandate = web_mandate(["mch_vuelaya", "mch_despegar", "mch_kayak", "mch_expedia"])
    mandate["constraints"]["allowed_categories"] = ["travel.hotels"]
    mandate["search_fields"] = HOTEL_FIELDS
    return mandate


def test_agent_run_buys_hotels_with_stored_fields(client, monkeypatch):
    """Mandato de hoteles: descubre con la categoría correcta y compra la más barata."""
    prompts = []
    def fake_search(prompt):
        prompts.append(prompt)
        return json.dumps(HOTEL_OFFERS)
    monkeypatch.setattr(merchant_search, "_call_web_search", fake_search)
    client.post("/mandates", json=hotel_mandate())

    result = client.post("/agent/run", json={"mandate_id": "mnd_web_001"}).json()

    assert "hotels in Cordoba" in prompts[0]
    assert result["purchase_completed"] is True
    assert result["selected_flight"]["merchant_id"] == "mch_despegar"
    assert result["selected_flight"]["price"] == 74.5
    assert result["selected_flight"]["category"] == "travel.hotels"
    assert result["attempt"]["purchase"]["category"] == "travel.hotels"
    assert "3 nights" in result["selected_flight"]["route"]


def test_agent_run_uses_mandate_stored_search_fields(client, monkeypatch):
    """Si el request no trae search_fields, se usan los guardados en el mandato."""
    monkeypatch.setattr(merchant_search, "_call_web_search", lambda p: json.dumps(WEB_OFFERS))
    mandate = web_mandate(["mch_despegar", "mch_kayak"])
    mandate["search_fields"] = SEARCH_FIELDS
    client.post("/mandates", json=mandate)

    result = client.post("/agent/run", json={"mandate_id": "mnd_web_001"}).json()

    assert result["discovery_source"] == "web"
    assert result["selected_flight"]["merchant_id"] == "mch_kayak"
    assert result["purchase_completed"] is True
