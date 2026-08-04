import frappe
from frappe import _

from medvisitpro.api import get_week_assignments
from medvisitpro.assets import asset_version
from medvisitpro.utils import is_location_gate_relaxed


def get_context(context):
    context.no_cache = 1

    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login"
        raise frappe.Redirect

    if "Delegate" not in frappe.get_roles(frappe.session.user):
        frappe.throw(_("You are not permitted to view this page"), frappe.PermissionError)

    context.delegate_name = frappe.db.get_value("User", frappe.session.user, "full_name") or frappe.session.user
    context.week_data = get_week_assignments()
    # Needed for authenticated POST calls from plain fetch() on this
    # standalone page (it doesn't extend templates/web.html, so
    # frappe's boot-injected csrf token isn't available otherwise).
    context.csrf_token = frappe.sessions.get_csrf_token()
    context.asset_version = asset_version()
    # Dev-only: lets the client skip its precision pre-check so the
    # visit flow can be tested on a laptop with no GPS. Off unless the
    # site opts in — see is_location_gate_relaxed(). The server gates
    # honour the same switch, so this only relaxes the UX pre-check.
    context.relax_location_gate = is_location_gate_relaxed()
