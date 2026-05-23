"""Schemas for the inbound/outbound activity calendar."""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel


class CalendarContainerRow(BaseModel):
    container_no: str
    ref_no: str  # WHPO# for inbound, TO# for outbound
    customer: str
    current_stage: str
    current_label: str


class CalendarDay(BaseModel):
    date: date
    inbound_containers: list[CalendarContainerRow] = []
    outbound_containers: list[CalendarContainerRow] = []


class CalendarResponse(BaseModel):
    window_start: date
    window_end: date
    days: list[CalendarDay]
