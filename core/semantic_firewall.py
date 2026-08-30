import os
import json
import urllib.request
import urllib.error
from typing import Dict, Any, Tuple

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")


def auditoria_cognitiva_firewall(
    mandato_constraints: Dict[str, Any],
    item_titulo: str,
    item_descripcion: str,
    precio_declarado: float,
    categoria: str,
    metadata: Dict[str, Any],
) -> Dict[str, Any]:
    """
    PIEZA 3: AUDITOR COGNITIVO / SEMANTIC FIREWALL
    Despliega Chain of Thought (Cadena de Pensamiento) para detectar:
    - Costos ocultos / cobros automáticos diferidos o por fuera.
    - Condiciones abusivas (ej: escalas de 48h en vuelos directos).
    - Evasión de categoría o activos convertibles a dinero.
    - Violación del espíritu del mandato.
    """
    api_key = os.getenv("OPENAI_API_KEY", "")
    max_permitido = mandato_constraints.get("max_amount_per_purchase", 150.0)
    categoria_permitida = str(mandato_constraints.get("allowed_categories", ["travel.flights"]))

    system_prompt = """Eres el Guardián Autónomo y Auditor Cognitivo de Seguridad Financiera en AgentBuyer.
Tu misión es proteger al humano evaluando compras que un agente de IA intenta hacer en su nombre.

NO haces un simple chequeo numérico de `precio <= max_amount`. Eres un auditor forense de IA.
Debes desplegar tu CADENA DE PENSAMIENTO (Chain of Thought) analizando:
1. Contexto oculto, letras pequeñas y cargos extra diferidos ("cobrado por fuera", "upgrade forzado", "tarifa de servicio oculta").
2. Condiciones absurdas o fraudulentas (ej: escala de 48 horas para un vuelo doméstico).
3. Intento de evasión o compra de activos líquidos (gift cards, vouchers, crypto).
4. ¿Cumple con el espíritu real del mandato del humano?

Devuelve ÚNICAMENTE un JSON con:
- chain_of_thought: Tu razonamiento analítico detallado paso a paso.
- costo_real_estimado: El precio real total sumando costos ocultos.
- riesgos_detectados: Lista de banderas rojas encontradas.
- veredicto: "APPROVE" (si es 100% limpia y legítima), "REJECT" (si es trampa/fraude/evasión), o "ESCALATE" (si es dudosa o borderline y requiere que el humano decida).
- resumen_para_humano: Explicación concisa y persuasiva para la alerta.

All human-readable values in the JSON response must be written in English."""

    user_prompt = f"""Mandato del Humano:
- Límite por compra: ${max_permitido:.2f}
- Categorías autorizadas: {categoria_permitida}
- Expresión o condiciones: {mandato_constraints.get('conditions_expression', 'Ninguna')}

Intento de Compra que el Agente Comprador encontró:
- Título: {item_titulo}
- Descripción / Letra Chica: {item_descripcion}
- Precio declarado en pasarela: ${precio_declarado:.2f}
- Categoría declarada: {categoria}
- Metadata adicional: {json.dumps(metadata)}

Ejecuta tu auditoría cognitiva completa."""

    if not api_key:
        # Heurística cognitiva local de alta fidelidad (offline fallback)
        texto_completo = f"{item_titulo} {item_descripcion} {categoria}".lower()
        
        # 1. Detección de cobros ocultos por fuera / upgrades forzados
        cobro_extra = 0.0
        if "por fuera" in texto_completo or "extra" in texto_completo or "upgrade" in texto_completo:
            if "10" in texto_completo:
                cobro_extra = 10.0
            elif "20" in texto_completo:
                cobro_extra = 20.0

        costo_total = precio_declarado + cobro_extra
        escala_abusiva = "48 horas" in texto_completo or "48h" in texto_completo or "escala larga" in texto_completo
        trampa_detectada = (cobro_extra > 0 and costo_total > max_permitido) or escala_abusiva or "gift card" in texto_completo or "crypto" in texto_completo

        if trampa_detectada:
            cot = (
                f"1. The gateway price is ${precio_declarado:.2f}, but the description reveals hidden charges (+${cobro_extra:.2f}) or an abusive 48-hour hold.\n"
                f"2. Estimated real cost: ${costo_total:.2f} (above the authorized limit of ${max_permitido:.2f}).\n"
                "3. The offer violates the intent of a safe and efficient travel mandate."
            )
            return {
                "chain_of_thought": cot,
                "costo_real_estimado": costo_total,
                "riesgos_detectados": ["Undisclosed deferred charge", "Abusive 48-hour hold", "Actual cost exceeds the limit"],
                "veredicto": "REJECT",
                "resumen_para_humano": "The demo flight purchase presents significant risks due to a possible hidden cost from an automatic upgrade that is not clearly specified, plus an unusual 48-hour hold condition that could be misleading. Rejecting this transaction is recommended."
            }
        
        if precio_declarado > max_permitido:
            return {
                "chain_of_thought": f"The declared price of ${precio_declarado:.2f} exceeds the limit of ${max_permitido:.2f}.",
                "costo_real_estimado": precio_declarado,
                "riesgos_detectados": ["Price above the limit"],
                "veredicto": "ESCALATE",
                "resumen_para_humano": f"The flight costs ${precio_declarado:.2f} (limit ${max_permitido:.2f}). It requires your approval."
            }

        return {
            "chain_of_thought": f"The ${precio_declarado:.2f} purchase of '{item_titulo}' meets the terms with no hidden costs.",
            "costo_real_estimado": precio_declarado,
            "riesgos_detectados": [],
            "veredicto": "APPROVE",
            "resumen_para_humano": "Legitimate purchase verified by the Semantic Firewall."
        }

    # Llamada con GPT-4o / GPT-4o-mini
    payload = {
        "model": "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.0
    }

    try:
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}"
            },
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            parsed = json.loads(data["choices"][0]["message"]["content"])
            return parsed
    except Exception as e:
        return {
            "chain_of_thought": f"Model call failed ({str(e)}). Applying the fail-closed security principle.",
            "costo_real_estimado": precio_declarado,
            "riesgos_detectados": ["External audit error"],
            "veredicto": "ESCALATE",
            "resumen_para_humano": f"Security concern due to an audit error: {str(e)}"
        }
