from pydantic import BaseModel, EmailStr, Field


class EmailIn(BaseModel):
    email: EmailStr

class VerifyCodeIn(BaseModel):
    email: EmailStr
    code: str = Field(pattern=r"^\d{6}$")


class TokenOut(BaseModel):
    token: str


class CodeSent(BaseModel):
    ok: bool
    expiresIn: int


class BackupSaved(BaseModel):
    version: int
    updatedAt: str
