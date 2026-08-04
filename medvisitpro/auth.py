import frappe


def get_home_page(user):
    """Registered via the get_website_user_home_page hook in
    hooks.py (NOT on_session_creation — that hook fires too early
    and Frappe core overwrites home_page afterward regardless of
    what it sets, confirmed via Network tab debugging earlier).
    """

    if user == "Administrator":
        return "desk"

    roles = frappe.get_roles(user)

    if "System Manager" in roles:
        return "app"

    if "Delegate Manager" in roles:
        return "managers"

    if "Delegate" in roles:
        return "delegate"

    return "app"
