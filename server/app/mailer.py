import os
import smtplib
from email.message import EmailMessage


def send_login_code(to_email: str, code: str) -> None:
    host = os.getenv("SMTP_HOST", "").strip()
    port = int(os.getenv("SMTP_PORT", "465"))
    username = os.getenv("SMTP_USERNAME", "").strip()
    password = os.getenv("SMTP_PASSWORD", "")
    sender = os.getenv("SMTP_FROM", "").strip() or username
    if not host or not username or not password or not sender:
        raise RuntimeError("SMTP is not configured")

    message = EmailMessage()
    message["Subject"] = "拍题入卷登录验证码"
    message["From"] = sender
    message["To"] = to_email
    message.set_content(
        "拍题入卷 · 云端备份登录\n\n"
        f"验证码：{code}\n"
        "（只输入上面冒号后的 6 位数字）\n\n"
        "有效期：10 分钟\n"
        "每条验证码只能使用一次。如果不是你本人操作，请忽略这封邮件。"
    )

    if port == 465:
        client = smtplib.SMTP_SSL(host, port, timeout=15)
    else:
        client = smtplib.SMTP(host, port, timeout=15)
    with client:
        if port != 465:
            client.starttls()
        client.login(username, password)
        client.send_message(message)
