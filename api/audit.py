"""Vistas de solo lectura para el trail de auditoría append-only."""

from fastapi import APIRouter

from audit.log import get_trail_for, reset_trail


router = APIRouter()


@router.post("/audit/reset")
def reset_audit_trail():
    """Abre una sesión de auditoría limpia para una nueva demo."""
    return reset_trail()


@router.get("/audit")
def get_audit_trail():
    """Devuelve el trail completo para la vista de auditoría."""
    return get_trail_for("auditor")


@router.get("/audit/{mandate_id}")
def get_mandate_audit_trail(mandate_id: str):
    """Devuelve los eventos visibles para el humano dueño de un mandato."""
    return get_trail_for("human", mandate_id)
