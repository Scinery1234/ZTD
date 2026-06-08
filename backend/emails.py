"""
HTML email templates for happen transactional emails.
All CSS is inlined for maximum email client compatibility.
"""

_BASE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>{subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#0d0802;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0d0802;padding:48px 16px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;">

          <!-- LOGO -->
          <tr>
            <td align="center" style="padding-bottom:32px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding-right:10px;vertical-align:middle;">
                    <div style="width:36px;height:36px;border-radius:9px;background:linear-gradient(140deg,#f97316 0%,#fbbf24 100%);text-align:center;line-height:36px;">
                      <svg width="16" height="16" viewBox="0 0 13 13" fill="none" style="margin-top:10px;display:inline-block;vertical-align:middle;">
                        <polyline points="1.5,6.5 5,10 11.5,3" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    </div>
                  </td>
                  <td style="vertical-align:middle;">
                    <span style="font-size:22px;font-weight:800;color:#f97316;letter-spacing:-0.5px;">happen</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CARD -->
          <tr>
            <td style="background-color:#1a1208;border:1px solid rgba(249,115,22,0.18);border-radius:18px;padding:44px 40px;">
              {body}
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td align="center" style="padding-top:28px;">
              <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.18);line-height:1.6;">
                © 2026 happen &nbsp;·&nbsp;
                <a href="{frontend_url}" style="color:rgba(249,115,22,0.4);text-decoration:none;">happen app</a>
              </p>
              <p style="margin:6px 0 0;font-size:11px;color:rgba(255,255,255,0.12);">
                You're receiving this because you signed up at happen.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


def _btn(url: str, label: str) -> str:
    return (
        f'<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 20px;">'
        f'<tr><td align="center">'
        f'<a href="{url}" style="display:inline-block;background:linear-gradient(135deg,#f97316,#d97706);'
        f'color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;'
        f'padding:15px 40px;border-radius:10px;letter-spacing:-0.1px;'
        f'box-shadow:0 4px 16px rgba(249,115,22,0.35);">{label}</a>'
        f'</td></tr></table>'
    )


def _fallback_url(url: str) -> str:
    return (
        f'<p style="margin:20px 0 0;font-size:12px;color:rgba(255,255,255,0.25);'
        f'text-align:center;line-height:1.7;">'
        f'Or copy and paste this link into your browser:<br/>'
        f'<a href="{url}" style="color:rgba(249,115,22,0.6);word-break:break-all;">{url}</a>'
        f'</p>'
    )


def _divider() -> str:
    return '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;"><tr><td style="border-top:1px solid rgba(255,255,255,0.07);"></td></tr></table>'


# ── Verification email ────────────────────────────────────────────────────────

VERIFY_SUBJECT = "Verify your happen account"

def verify_html(name: str, verify_url: str, frontend_url: str) -> str:
    body = f"""
      <h1 style="margin:0 0 10px;font-size:24px;font-weight:800;color:#ffffff;letter-spacing:-0.4px;">
        Confirm your email
      </h1>
      <p style="margin:0 0 4px;font-size:15px;color:rgba(255,255,255,0.55);line-height:1.65;">
        Hi <strong style="color:rgba(255,255,255,0.8);">{name}</strong> — one quick step before you dive in.
        Click below to verify your email address and activate your account.
      </p>

      {_btn(verify_url, "Verify my email →")}

      <!-- Expiry note -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="background:rgba(249,115,22,0.07);border:1px solid rgba(249,115,22,0.15);
                     border-radius:10px;padding:12px 16px;text-align:center;">
            <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.4);line-height:1.5;">
              ⏱ This link expires in <strong style="color:rgba(255,255,255,0.6);">24 hours</strong>.
              If you didn't create a happen account you can safely ignore this email.
            </p>
          </td>
        </tr>
      </table>

      {_fallback_url(verify_url)}
    """
    return _BASE.format(subject=VERIFY_SUBJECT, body=body, frontend_url=frontend_url)


# ── Welcome email ─────────────────────────────────────────────────────────────

WELCOME_SUBJECT = "You're in — welcome to happen 🎉"

def _feature_row(emoji: str, title: str, desc: str) -> str:
    return (
        f'<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">'
        f'<tr>'
        f'<td width="40" style="vertical-align:top;padding-top:2px;">'
        f'<div style="width:32px;height:32px;background:rgba(249,115,22,0.12);border-radius:8px;'
        f'text-align:center;line-height:32px;font-size:16px;">{emoji}</div>'
        f'</td>'
        f'<td style="padding-left:12px;vertical-align:top;">'
        f'<p style="margin:0 0 2px;font-size:14px;font-weight:700;color:rgba(255,255,255,0.88);">{title}</p>'
        f'<p style="margin:0;font-size:13px;color:rgba(255,255,255,0.42);line-height:1.55;">{desc}</p>'
        f'</td>'
        f'</tr>'
        f'</table>'
    )


def welcome_html(name: str, app_url: str, frontend_url: str) -> str:
    first = name.split()[0] if name else "there"
    body = f"""
      <!-- Hero -->
      <h1 style="margin:0 0 10px;font-size:26px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">
        Welcome, {first}! 🎉
      </h1>
      <p style="margin:0 0 32px;font-size:15px;color:rgba(255,255,255,0.5);line-height:1.65;">
        Your account is verified and ready. Here's a quick look at what you can do with happen:
      </p>

      <!-- Features -->
      {_feature_row("✅", "Natural language tasks", "Type &ldquo;Call Lisa tomorrow !urgent ~weekly&rdquo; — happen parses it instantly.")}
      {_feature_row("📅", "Timebox your day", "Drag tasks onto your daily calendar and see your day take shape.")}
      {_feature_row("🎩", "Hats — areas of life", "Group tasks by Work, Health, Personal, or any hat you create.")}
      {_feature_row("🧵", "Loose Threads", "A scratch pad for ideas that don't belong on a to-do list yet.")}

      {_divider()}

      <!-- CTA -->
      <p style="margin:0 0 4px;font-size:14px;color:rgba(255,255,255,0.45);text-align:center;">
        Ready to make things happen?
      </p>
      {_btn(app_url, "Open happen →")}

      <p style="margin:24px 0 0;font-size:13px;color:rgba(255,255,255,0.28);text-align:center;line-height:1.6;">
        Have feedback or hit a snag? Just reply to this email — it goes straight to the team.
      </p>
    """
    return _BASE.format(subject=WELCOME_SUBJECT, body=body, frontend_url=frontend_url)
