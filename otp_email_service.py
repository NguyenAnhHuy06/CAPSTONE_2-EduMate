#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import argparse
import json
import os
import random
import smtplib
import string
import sys
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

try:
    from dotenv import load_dotenv

    load_dotenv()
except Exception:
    pass


def generate_otp(length=6):
    length = max(4, min(length, 10))
    return "".join(random.choices(string.digits, k=length))


def purpose_description(purpose):
    p = (purpose or "login").strip().lower()
    mapping = {
        "register": "complete your registration",
        "signup": "complete your registration",
        "sign-up": "complete your registration",
        "login": "verify your sign-in",
        "signin": "verify your sign-in",
        "reset": "reset your password",
        "password-reset": "reset your password",
        "verify": "verify your email address",
    }
    return mapping.get(p, "continue with your request")


def build_html_email(code, ttl_minutes, recipient_email, purpose):
    desc = purpose_description(purpose)
    year = datetime.now().year
    brand = os.getenv("OTP_BRAND_NAME", "EduMate")
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Verification code — {brand}</title>
</head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f4f7fa;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f7fa;padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.08);overflow:hidden;">
<tr>
<td style="background:linear-gradient(135deg,#4f46e5 0%,#6366f1 100%);padding:32px 24px;text-align:center;">
<h1 style="color:#ffffff;margin:0;font-size:26px;font-weight:600;">{brand}</h1>
<p style="color:rgba(255,255,255,0.92);margin:10px 0 0;font-size:15px;">One-time verification code</p>
</td>
</tr>
<tr>
<td style="padding:36px 28px;">
<p style="color:#374151;margin:0 0 16px;font-size:16px;line-height:1.6;">Hello,</p>
<p style="color:#6b7280;margin:0 0 24px;font-size:15px;line-height:1.65;">
Use the code below to <strong>{desc}</strong>. Enter it in the app or on the website where you requested it.
This code is valid for one use only.
</p>
<table width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
<tr><td align="center" style="background:#f9fafb;border-radius:10px;padding:28px 20px;border:1px solid #e5e7eb;">
<p style="color:#9ca3af;font-size:12px;margin:0 0 10px;text-transform:uppercase;letter-spacing:2px;">Your code</p>
<div style="font-size:40px;font-weight:700;color:#4f46e5;letter-spacing:10px;font-family:'Courier New',Consolas,monospace;">{code}</div>
<p style="color:#9ca3af;font-size:13px;margin:16px 0 0;">Expires in <strong style="color:#374151;">{ttl_minutes} minutes</strong></p>
</td></tr>
</table>
<div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:14px 16px;border-radius:6px;margin:0 0 20px;">
<p style="color:#92400e;font-size:14px;margin:0;line-height:1.55;">
<strong>Security:</strong> Never share this code with anyone. {brand} will never ask for your OTP by phone or in a separate email.
If you did not request this code, you can ignore this message.
</p>
</div>
<p style="color:#9ca3af;font-size:13px;margin:0;line-height:1.5;">This message was sent to <strong style="color:#6b7280;">{recipient_email}</strong></p>
</td>
</tr>
<tr>
<td style="background:#f9fafb;padding:24px;text-align:center;border-top:1px solid #e5e7eb;">
<p style="color:#9ca3af;font-size:12px;margin:0;">© {year} {brand}. All rights reserved.</p>
</td>
</tr>
</table>
</td></tr>
</table>
</body>
</html>
"""


def build_plain_text_email(code, ttl_minutes, purpose):
    brand = os.getenv("OTP_BRAND_NAME", "EduMate")
    desc = purpose_description(purpose)
    return f"""{brand} — Verification code

Hello,

Use this code to {desc}:

{code}

This code expires in {ttl_minutes} minutes. It can only be used once.

Security: Do not share this code with anyone. {brand} will never ask for your OTP by phone or in another email. If you did not request this code, you can ignore this message.

— {brand} Team
"""


def send_otp_email(recipient, code, ttl_seconds, purpose):
    smtp_host = os.getenv("SMTP_HOST")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_user = os.getenv("SMTP_USER")
    smtp_password = os.getenv("SMTP_PASS")
    sender_email = os.getenv("SMTP_FROM", smtp_user or "")
    sender_name = os.getenv("OTP_SENDER_NAME", "EduMate")
    use_tls = os.getenv("SMTP_USE_TLS", "true").lower() == "true"

    if not all([smtp_host, smtp_user, smtp_password, sender_email]):
        raise ValueError("Missing SMTP config: SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM")

    ttl_minutes = max(1, round(ttl_seconds / 60))
    brand = os.getenv("OTP_BRAND_NAME", "EduMate")
    subject_default = f"Your {brand} verification code"
    subject = os.getenv("OTP_EMAIL_SUBJECT", subject_default)

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{sender_name} <{sender_email}>"
    msg["To"] = recipient
    msg.attach(MIMEText(build_plain_text_email(code, ttl_minutes, purpose), "plain", "utf-8"))
    msg.attach(MIMEText(build_html_email(code, ttl_minutes, recipient, purpose), "html", "utf-8"))

    with smtplib.SMTP(smtp_host, smtp_port, timeout=30) as server:
        if use_tls:
            server.starttls()
        server.login(smtp_user, smtp_password)
        server.send_message(msg)


def main():
    parser = argparse.ArgumentParser(description="Send OTP via SMTP")
    parser.add_argument("--email", required=True)
    parser.add_argument("--code")
    parser.add_argument("--code-length", type=int, default=int(os.getenv("OTP_CODE_LENGTH", "6")))
    parser.add_argument("--ttl", type=int, default=int(os.getenv("OTP_CODE_TTL", "300")))
    parser.add_argument("--purpose", default="login")
    args = parser.parse_args()

    otp_code = args.code.strip() if args.code else generate_otp(args.code_length)

    try:
        send_otp_email(args.email, otp_code, args.ttl, args.purpose)
        print(
            json.dumps(
                {
                    "status": "success",
                    "code": otp_code,
                    "expires_in": args.ttl,
                    "email": args.email,
                    "timestamp": datetime.now().isoformat(),
                },
                ensure_ascii=False,
            )
        )
        sys.exit(0)
    except Exception as e:
        print(
            json.dumps(
                {
                    "status": "error",
                    "error": str(e),
                    "email": args.email,
                    "timestamp": datetime.now().isoformat(),
                },
                ensure_ascii=False,
            )
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
