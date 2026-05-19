"""Pydantic models for vendor self-service auth."""

from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field, field_validator


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    full_name: str = Field(min_length=2, max_length=120)
    company: str = Field(min_length=2, max_length=120)

    @field_validator("full_name", "company")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class ResetPasswordRequest(BaseModel):
    email: EmailStr
    new_password: str = Field(min_length=8, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: "VendorUserResponse"


class VendorUserResponse(BaseModel):
    email: EmailStr
    full_name: str
    company: str


TokenResponse.model_rebuild()
