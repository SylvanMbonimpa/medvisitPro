import frappe
from frappe import _

from medvisitpro.api import get_team_week_data
from medvisitpro.assets import asset_version
from medvisitpro.utils import manager_role_label


def get_context(context):
    context.no_cache = 1

    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login"
        raise frappe.Redirect

    if "Delegate Manager" not in frappe.get_roles(frappe.session.user):
        frappe.throw(_("You are not permitted to view this page"), frappe.PermissionError)

    context.manager_name = frappe.db.get_value("User", frappe.session.user, "full_name") or frappe.session.user
    context.manager_image = frappe.db.get_value("User", frappe.session.user, "user_image") or ""
    context.manager_email = frappe.session.user
    # Gates the "also give Delegate Manager access" checkbox and the
    # brand checklist client-side — see _require_regional_manager in
    # api.py, which is the actual enforcement; this is just so the form
    # doesn't invite an action the server will reject.
    context.is_regional_manager = "Regional Manager" in frappe.get_roles(frappe.session.user)
    context.manager_role_label = manager_role_label(frappe.session.user)
    context.week_data = get_team_week_data()
    # Analytics moved to /report — see www/report.py. Dropping the call
    # here also takes a category scan and an order-value roll-up off the
    # dashboard's first paint.
    context.csrf_token = frappe.sessions.get_csrf_token()
    context.asset_version = asset_version()
