import time
from uuid import uuid4

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.db import Base
from app.models import EmailCode, User


def test_health(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_request_code_then_verify_creates_account(client, sent_codes):
    email = f"{uuid4().hex}@example.com"
    requested = client.post("/api/auth/request-code", json={"email": email})
    assert requested.status_code == 200
    assert requested.json() == {"ok": True, "expiresIn": 600}
    assert sent_codes["email"] == email
    assert len(sent_codes["code"]) == 6 and sent_codes["code"].isdigit()

    verified = client.post(
        "/api/auth/verify-code",
        json={"email": email, "code": sent_codes["code"]},
    )
    assert verified.status_code == 200
    assert verified.json()["token"]

    reused = client.post(
        "/api/auth/verify-code",
        json={"email": email, "code": sent_codes["code"]},
    )
    assert reused.status_code == 400


def test_existing_account_can_login_with_new_code(client, sent_codes, db_session):
    email = f"{uuid4().hex}@example.com"
    assert client.post("/api/auth/request-code", json={"email": email}).status_code == 200
    first = client.post("/api/auth/verify-code", json={"email": email, "code": sent_codes["code"]})
    assert first.status_code == 200

    db_session.query(EmailCode).filter(EmailCode.email == email).update(
        {EmailCode.created_at: time.time() - 120}
    )
    db_session.commit()

    assert client.post("/api/auth/request-code", json={"email": email}).status_code == 200
    second = client.post("/api/auth/verify-code", json={"email": email, "code": sent_codes["code"]})
    assert second.status_code == 200
    assert db_session.query(User).filter(User.email == email).count() == 1


def test_wrong_code_does_not_consume_valid_code(client, sent_codes):
    email = f"{uuid4().hex}@example.com"
    assert client.post("/api/auth/request-code", json={"email": email}).status_code == 200
    wrong = "000000" if sent_codes["code"] != "000000" else "111111"
    rejected = client.post("/api/auth/verify-code", json={"email": email, "code": wrong})
    assert rejected.status_code == 400
    assert rejected.json()["detail"] == "验证码错误"

    accepted = client.post("/api/auth/verify-code", json={"email": email, "code": sent_codes["code"]})
    assert accepted.status_code == 200


def test_resend_cooldown(client, sent_codes):
    email = f"{uuid4().hex}@example.com"
    assert client.post("/api/auth/request-code", json={"email": email}).status_code == 200
    again = client.post("/api/auth/request-code", json={"email": email})
    assert again.status_code == 429


def test_code_locks_after_five_failures(client, sent_codes):
    email = f"{uuid4().hex}@example.com"
    assert client.post("/api/auth/request-code", json={"email": email}).status_code == 200
    wrong = "000000" if sent_codes["code"] != "000000" else "111111"
    for _ in range(5):
        assert client.post("/api/auth/verify-code", json={"email": email, "code": wrong}).status_code == 400
    locked = client.post("/api/auth/verify-code", json={"email": email, "code": sent_codes["code"]})
    assert locked.status_code == 429


def test_expired_code_is_rejected(client, sent_codes, db_session):
    email = f"{uuid4().hex}@example.com"
    assert client.post("/api/auth/request-code", json={"email": email}).status_code == 200
    db_session.query(EmailCode).filter(EmailCode.email == email).update(
        {EmailCode.expires_at: time.time() - 1}
    )
    db_session.commit()
    expired = client.post("/api/auth/verify-code", json={"email": email, "code": sent_codes["code"]})
    assert expired.status_code == 400


def test_request_code_without_smtp_config_is_503(client, monkeypatch):
    for key in ("SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM"):
        monkeypatch.delenv(key, raising=False)
    response = client.post("/api/auth/request-code", json={"email": f"{uuid4().hex}@example.com"})
    assert response.status_code == 503


def test_protected_endpoint_requires_token(client):
    assert client.get("/api/backup").status_code == 401
    assert client.get("/api/backup", headers={"Authorization": "Bearer invalid"}).status_code == 401


def test_legacy_user_table_accepts_otp_user(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE users ("
                "id INTEGER NOT NULL PRIMARY KEY, "
                "email VARCHAR(320) NOT NULL, "
                "password_hash VARCHAR(128) NOT NULL, "
                "created_at DATETIME NOT NULL)"
            )
        )
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        user = User(email=f"{uuid4().hex}@example.com")
        db.add(user)
        db.commit()
        db.refresh(user)
        assert user.legacy_password_hash == ""
