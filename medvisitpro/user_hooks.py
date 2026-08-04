import frappe
from frappe import _

# The territory every delegate's *secondary* area must fall outside of.
# Kigali City is a Territory in the stock tree (renamed from ERPNext's
# default 'Kigali' — see setup_territories in setup_custom_fields.py),
# so "outside Kigali" means neither it itself nor anything nested
# beneath it — picking a sector inside the city has to fail the same
# way picking the city does.
CAPITAL_TERRITORY = "Kigali City"


def _territory_ancestry(territory):
    """The territory and every ancestor above it, nearest first.

    Walks parent_territory rather than reading the nested-set lft/rgt
    columns: the walk is correct even if the tree's bounds are stale
    after a manual edit or a partial import."""
    chain = []
    seen = set()
    current = territory
    while current and current not in seen:
        chain.append(current)
        seen.add(current)
        current = frappe.db.get_value("Territory", current, "parent_territory")
    return chain


def is_within_territory(territory, ancestor):
    """Whether `territory` is `ancestor` or sits underneath it."""
    if not territory or not ancestor:
        return False
    return ancestor in _territory_ancestry(territory)


def enforce_manager_role_bundle(doc, method=None):
    """User.validate hook.

    Regional Manager > Delegate Manager > Delegate is meant to be a
    strict chain: every _require_manager()/_require_delegate() gate in
    api.py, every DocType permission row, and — just as importantly —
    every app UI that lists or edits "delegates" (list_delegates,
    get_delegate/update_delegate, the Delegates table itself) all key
    off the "Delegate" role specifically. create_delegate already
    grants the whole chain together when someone is onboarded in-app;
    this is the same guarantee for the desk User form, where assigning
    "Delegate Manager" or "Regional Manager" by hand — without also
    ticking "Delegate" — silently produces a manager the app's own
    Delegates list can't see and can't edit."""
    roles = {r.role for r in doc.roles}
    if "Regional Manager" in roles:
        roles.add("Delegate Manager")
    if "Delegate Manager" in roles:
        roles.add("Delegate")

    existing = {r.role for r in doc.roles}
    for role in roles - existing:
        doc.append("roles", {"role": role})


def enforce_secondary_territory(doc, method=None):
    """User.validate hook.

    A delegate's secondary territory is the whole point of having two —
    it's the guarantee that someone is covering ground outside the
    capital. Letting it be set to Kigali (or a sector within it) makes
    the field decorative, so it's rejected here rather than left to
    whoever fills the form.

    Silent when the field is empty: not every user is a delegate, and a
    delegate can be set up before their upcountry area is decided.
    """
    secondary = doc.get("secondary_territory")
    if not secondary:
        return

    primary = doc.get("primary_territory")
    if primary and primary == secondary:
        frappe.throw(
            _("Primary and secondary territory can't both be {0}.").format(primary),
            title=_("Same Territory Twice"),
        )

    # If the site has no Kigali territory there is nothing to hold the
    # rule against — don't block the save over a missing reference.
    if not frappe.db.exists("Territory", CAPITAL_TERRITORY):
        return

    if is_within_territory(secondary, CAPITAL_TERRITORY):
        frappe.throw(
            _(
                "{0} is inside {1}. A delegate's secondary territory has to be "
                "outside the capital — that's what makes it a second area to "
                "cover rather than a second name for the first."
            ).format(secondary, CAPITAL_TERRITORY),
            title=_("Secondary Territory Must Be Outside {0}").format(CAPITAL_TERRITORY),
        )
