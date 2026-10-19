import secrets
import time

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from ..auth import create_access_token, hash_login_code, login_code_matches
from ..db import get_db
from ..mailer import send_login_code
from ..models import EmailCode, User
from ..schemas import CodeSent, EmailIn, TokenOut, VerifyCodeIn

router = APIRouter(prefix="/api/auth", tags=["auth"])

CODE_TTL_SECONDS = 600
RESEND_SECONDS = 60
MAX_ATTEMPTS = 5
MAX_EMAIL_CODES_PER_HOUR = 5
MAX_IP_CODES_PER_HOUR = 30


@router.post("/request-code", response_model=CodeSent)
def request_code(payload: EmailIn, request: Request, db: Session = Depends(get_db)):
    email = payload.email.lower()
    now = time.time()
    ip = request.client.host if request.client else "unknown"

    last = (
        db.query(EmailCode)
        .filter(EmailCode.email == email)
        .order_by(EmailCode.created_at.desc())
        .first()
    )
    if last and now - last.created_at < RESEND_SECONDS:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"验证码发送过于频繁，请 {RESEND_SECONDS} 秒后再试",
        )
    hour_ago = now - 3600
    email_count = (
        db.query(EmailCode)
        .filter(EmailCode.email == email, EmailCode.created_at >= hour_ago)
        .count()
    )
    if email_count >= MAX_EMAIL_CODES_PER_HOUR:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="该邮箱请求验证码次数过多，请稍后再试")
    ip_count = (
        db.query(EmailCode)
        .filter(EmailCode.ip == ip, EmailCode.created_at >= hour_ago)
        .count()
    )
    if ip_count >= MAX_IP_CODES_PER_HOUR:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="当前网络请求验证码次数过多，请稍后再试")

    db.query(EmailCode).filter(EmailCode.expires_at < now - 86400).delete(synchronize_session=False)
    code = f"{secrets.randbelow(1_000_000):06d}"
    db.add(
        EmailCode(
            email=email,
            ip=ip,
            code_hash=hash_login_code(email, code),
            created_at=now,
            expires_at=now + CODE_TTL_SECONDS,
        )
    )
    try:
        send_login_code(email, code)
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="邮件发送失败，请检查服务器 SMTP 配置",
        )
    db.commit()
    return {"ok": True, "expiresIn": CODE_TTL_SECONDS}


@router.post("/verify-code", response_model=TokenOut)
def verify_code(payload: VerifyCodeIn, db: Session = Depends(get_db)):
    email = payload.email.lower()
    now = time.time()
    record = (
        db.query(EmailCode)
        .filter(EmailCode.email == email, EmailCode.used.is_(False))
        .order_by(EmailCode.created_at.desc())
        .first()
    )
    if record is None or record.expires_at < now:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="验证码无效或已过期")
    if record.attempts >= MAX_ATTEMPTS:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="验证码尝试次数过多，请重新获取")

    record.attempts += 1
    if not login_code_matches(email, payload.code, record.code_hash):
        db.commit()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="验证码错误")
    record.used = True

    user = db.query(User).filter(User.email == email).first()
    if user is None:
        user = User(email=email)
        db.add(user)
        db.flush()
    else:
        user.legacy_password_hash = ""
    db.commit()
    return {"token": create_access_token(user.id)}
