import frappe
from frappe import _

from medvisitpro.api import get_team_analytics, get_visit_trend
from medvisitpro.assets import asset_version
from medvisitpro.utils import manager_role_label


def get_context(context):
    """The manager's analytics page.

    Split out of the dashboard, which is now purely operational. Anything
    period-scoped — the totals, the category and client breakdowns, the
    six-month trend — reports from here instead, so the dashboard stays
    a view of what needs doing today.
    """
    context.no_cache = 1

    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login"
        raise frappe.Redirect

    if "Delegate Manager" not in frappe.get_roles(frappe.session.user):
        frappe.throw(_("You are not permitted to view this page"), frappe.PermissionError)

    context.manager_name = (
        frappe.db.get_value("User", frappe.session.user, "full_name") or frappe.session.user
    )
    context.manager_image = frappe.db.get_value("User", frappe.session.user, "user_image") or ""
    context.manager_email = frappe.session.user
    context.manager_role_label = manager_role_label(frappe.session.user)

    # Defaults to the current week; the month/week selectors re-fetch
    # through api.get_team_analytics from there.
    context.analytics = get_team_analytics()
    # Fixed six-month window — the selectors don't scope it, so there's
    # nothing to re-fetch and it can be rendered with the page.
    context.trend = get_visit_trend()
    context.csrf_token = frappe.sessions.get_csrf_token()
    context.asset_version = asset_version()
