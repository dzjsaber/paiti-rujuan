import pytest

from app.mailer import send_login_code


def test_send_login_code_requires_smtp_config(monkeypatch):
    for key in ("SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM"):
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(RuntimeError, match="not configured"):
        send_login_code("someone@example.com", "123456")


def test_send_login_code_builds_smtp_message(monkeypatch):
    sent = {}

    class FakeSMTP:
        def __init__(self, host, port, timeout):
            sent["host"] = host
            sent["port"] = port

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

        def login(self, username, password):
            sent["login"] = (username, password)

        def send_message(self, message):
            sent["message"] = message

    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_PORT", "465")
    monkeypatch.setenv("SMTP_USERNAME", "sender@example.com")
    monkeypatch.setenv("SMTP_PASSWORD", "authorization-code")
    monkeypatch.setenv("SMTP_FROM", "sender@example.com")
    monkeypatch.setattr("app.mailer.smtplib.SMTP_SSL", FakeSMTP)

    send_login_code("receiver@example.com", "123456")

    assert sent["host"] == "smtp.example.com"
    assert sent["port"] == 465
    assert sent["login"] == ("sender@example.com", "authorization-code")
    assert sent["message"]["To"] == "receiver@example.com"
    body = sent["message"].get_content()
    assert "验证码：123456\n" in body
    assert "只输入上面冒号后的 6 位数字" in body
    assert "有效期：10 分钟" in body
