import hashlib
import json
import threading
from copy import deepcopy
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Tuple, Union
from uuid import uuid4

from shared.schemas import AuditLogEntry, EventType, ActorType
from mandate.sign import canonical_json

_EVENT_TYPES = {
    "mandate_created",
    "verification",
    "revocation",
    "purchase_completed",
    "agent_run",
    "human_override_approved",
    "human_override_declined",
}

# Se agrega únicamente con append_entry; no existe una operación de borrado.
AUDIT_TRAIL: list[dict] = []


class CryptographicAuditLedger:
    """
    Append-only SHA-256 hash-chained cryptographic ledger.
    Every event is cryptographically linked to the previous entry, providing tamper-evident proof
    for cardholders, merchants, and chargeback auditors.
    """

    GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000"

    def __init__(self):
        self._entries: List[AuditLogEntry] = []
        self._lock = threading.Lock()

    def _compute_hash(
        self,
        index: int,
        prev_hash: str,
        timestamp: str,
        event_type: str,
        actor_type: str,
        actor_id: str,
        mandate_id: Optional[str],
        attempt_id: Optional[str],
        details: Dict[str, Any],
    ) -> str:
        payload = {
            "index": index,
            "prev_hash": prev_hash,
            "timestamp": timestamp,
            "event_type": event_type,
            "actor_type": actor_type,
            "actor_id": actor_id,
            "mandate_id": mandate_id,
            "attempt_id": attempt_id,
            "details": details,
        }
        return hashlib.sha256(canonical_json(payload)).hexdigest()

    def append_entry(
        self,
        event_type: Union[EventType, str],
        actor_type: Union[ActorType, str],
        actor_id: str,
        details: Dict[str, Any],
        mandate_id: Optional[str] = None,
        attempt_id: Optional[str] = None,
        signature: Optional[str] = None,
    ) -> AuditLogEntry:
        with self._lock:
            index = len(self._entries)
            prev_hash = self.GENESIS_HASH if index == 0 else self._entries[-1].hash
            timestamp = datetime.now(timezone.utc).isoformat()

            e_type_str = event_type.value if hasattr(event_type, "value") else str(event_type)
            a_type_str = actor_type.value if hasattr(actor_type, "value") else str(actor_type)

            curr_hash = self._compute_hash(
                index=index,
                prev_hash=prev_hash,
                timestamp=timestamp,
                event_type=e_type_str,
                actor_type=a_type_str,
                actor_id=actor_id,
                mandate_id=mandate_id,
                attempt_id=attempt_id,
                details=details,
            )

            entry = AuditLogEntry(
                entry_id=f"evt_{uuid4().hex[:10]}",
                index=index,
                prev_hash=prev_hash,
                timestamp=timestamp,
                event_type=e_type_str,
                actor_type=a_type_str,
                actor_id=actor_id,
                mandate_id=mandate_id,
                attempt_id=attempt_id,
                details=details,
                hash=curr_hash,
                signature=signature,
            )
            self._entries.append(entry)
            return entry

    def verify_chain_integrity(self) -> Tuple[bool, str]:
        with self._lock:
            if not self._entries:
                return True, "Audit log is empty (valid)."

            expected_prev = self.GENESIS_HASH
            for i, entry in enumerate(self._entries):
                if entry.index != i:
                    return False, f"Broken sequence at index {i}: found index {entry.index}"
                if entry.prev_hash != expected_prev:
                    return False, f"Broken link at index {i}: prev_hash {entry.prev_hash} != {expected_prev}"

                calculated_hash = self._compute_hash(
                    index=entry.index,
                    prev_hash=entry.prev_hash,
                    timestamp=entry.timestamp,
                    event_type=entry.event_type.value if hasattr(entry.event_type, "value") else str(entry.event_type),
                    actor_type=entry.actor_type.value if hasattr(entry.actor_type, "value") else str(entry.actor_type),
                    actor_id=entry.actor_id,
                    mandate_id=entry.mandate_id,
                    attempt_id=entry.attempt_id,
                    details=entry.details,
                )
                if calculated_hash != entry.hash:
                    return False, f"Tampered entry at index {i}: calculated hash {calculated_hash} != stored {entry.hash}"

                expected_prev = entry.hash

            return True, "Chain integrity 100% verified (Zero tampering detected)."

    def get_all_entries(self) -> List[AuditLogEntry]:
        with self._lock:
            return [e.model_copy(deep=True) for e in self._entries]

    def get_trail_for(self, role: str = "auditor", mandate_id: Optional[str] = None, attempt_id: Optional[str] = None) -> List[AuditLogEntry]:
        with self._lock:
            entries = self._entries
            if mandate_id:
                entries = [e for e in entries if e.mandate_id == mandate_id]
            if attempt_id:
                entries = [e for e in entries if e.attempt_id == attempt_id]
            return [e.model_copy(deep=True) for e in entries]

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()



# Global singleton audit ledger
audit_ledger = CryptographicAuditLedger()


def append_entry(event: dict) -> dict:
    """Agrega un evento inmutable para los consumidores del trail de auditoría."""
    event_type = event.get("type")
    if event_type not in _EVENT_TYPES and event_type not in [e.value for e in EventType]:
        raise ValueError(f"Tipo de evento de auditoría inválido: {event_type!r}")
    if "mandate_id" not in event or "summary" not in event:
        raise ValueError("Todo evento requiere mandate_id y summary.")

    entry = deepcopy(event)
    entry["event_id"] = f"evt_{uuid4().hex}"
    entry["timestamp"] = datetime.now(timezone.utc).isoformat()
    AUDIT_TRAIL.append(entry)

    # Replicar al ledger criptográfico
    audit_ledger.append_entry(
        event_type=event_type,
        actor_type="GATEWAY",
        actor_id="system_gateway",
        mandate_id=event.get("mandate_id"),
        attempt_id=event.get("attempt_id"),
        details=event,
    )
    return deepcopy(entry)


def get_trail_for(role: str = "auditor", mandate_id: str | None = None, attempt_id: str | None = None) -> list[dict]:
    """Lee el trail descendente y aplica la visibilidad del rol solicitado."""
    if role == "auditor":
        entries = AUDIT_TRAIL
    elif role in {"human", "merchant"}:
        entries = [entry for entry in AUDIT_TRAIL if mandate_id and entry.get("mandate_id") == mandate_id]
    else:
        entries = AUDIT_TRAIL

    return deepcopy(sorted(entries, key=lambda entry: entry["timestamp"], reverse=True))


def reset_trail() -> dict:
    """Reinicia explícitamente la sesión de auditoría en memoria para una demo nueva.

    Durante una sesión el trail sigue siendo append-only. Este corte sólo se
    invoca al iniciar/reiniciar una demo y también reinicia la cadena hash.
    """
    removed = len(AUDIT_TRAIL)
    AUDIT_TRAIL.clear()
    audit_ledger.clear()
    return {"cleared": removed, "status": "reset"}
