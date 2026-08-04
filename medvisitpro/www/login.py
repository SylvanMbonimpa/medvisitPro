import frappe

from medvisitpro.assets import asset_version


def get_context(context):
    """Context for the custom www/login.html page.

    Note: the "usr" field posted to /api/method/login accepts either
    an email address or a username natively — Frappe core resolves
    it against the User doctype's `email` and `username` fields.
    No extra lookup logic is needed here.
    """
    context.no_cache = 1

    # If the user is already logged in, skip the login page entirely
    if frappe.session.user != "Guest":
        frappe.local.flags.redirect_location = get_role_home_page()
        raise frappe.Redirect

    context.google_login_url = get_google_login_url()
    context.asset_version = asset_version()


def get_role_home_page():
    """Best-effort redirect target for an already-logged-in user
    hitting /login directly. Mirrors the logic in auth.py's
    on_session_creation hook so behavior stays consistent."""
    roles = frappe.get_roles(frappe.session.user)

    if "Delegate" in roles:
        return "/delegate"
    elif "Patient" in roles:
        return "/patient-portal"
    elif "Receptionist" in roles:
        return "/reception-desk"
    return "/app"


def get_google_login_url():
    """Return the Google OAuth login URL only if a Social Login Key
    for Google exists and is enabled. Keeps the button hidden
    otherwise instead of showing a dead link."""
    try:
        provider = frappe.get_doc("Social Login Key", "google")
        if provider.get("enable_social_login"):
            return "/api/method/frappe.integrations.oauth2_logins.login_via_google"
    except frappe.DoesNotExistError:
        pass
    return None
