import os

os.environ.setdefault("JWT_SECRET", "test-secret")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base, get_db
from app.main import app

test_engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=test_engine, autoflush=False, expire_on_commit=False)
Base.metadata.create_all(bind=test_engine)


def override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


app.dependency_overrides[get_db] = override_get_db


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


@pytest.fixture
def sent_codes(monkeypatch):
    sent = {}
    monkeypatch.setattr(
        "app.routers.auth.send_login_code",
        lambda email, code: sent.update(email=email, code=code),
    )
    return sent


@pytest.fixture
def login(client, sent_codes):
    from uuid import uuid4

    def do(email=None):
        email = email or f"{uuid4().hex}@example.com"
        requested = client.post("/api/auth/request-code", json={"email": email})
        assert requested.status_code == 200
        verified = client.post(
            "/api/auth/verify-code",
            json={"email": email, "code": sent_codes["code"]},
        )
        assert verified.status_code == 200
        return {
            "email": email,
            "token": verified.json()["token"],
            "headers": {"Authorization": f"Bearer {verified.json()['token']}"},
        }

    return do


@pytest.fixture
def db_session():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()
