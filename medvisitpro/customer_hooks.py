import frappe
from frappe import _
from frappe.model.naming import make_autoname

from medvisitpro.utils import is_geofence_enabled

# Stable, app-owned client identifier. Deliberately not ERPNext's record
# name: this site names Customers after customer_name, so the record name
# changes the moment a client is renamed and can't be used as a key.
# The spreadsheet import matches on this to update a client rather than
# create a duplicate — see import_clients in api.py.
CLIENT_ID_SERIES = "MVP-.#####"


def assign_client_id(doc, method=None):
    """Customer.before_insert hook. Gives every new client an ID.

    Never overwrites one that's already set, so a record restored from a
    backup or created by a fixture keeps the identifier the outside world
    already knows it by."""
    if not doc.get("medvisitpro_client_id"):
        doc.medvisitpro_client_id = make_autoname(CLIENT_ID_SERIES)


def backfill_client_ids():
    """One-off: give existing clients an ID. Safe to run repeatedly —
    it only touches rows that don't have one yet."""
    missing = frappe.get_all(
        "Customer",
        filters=[["medvisitpro_client_id", "in", ["", None]]],
        pluck="name",
    )
    for name in missing:
        frappe.db.set_value(
            "Customer", name, "medvisitpro_client_id",
            make_autoname(CLIENT_ID_SERIES), update_modified=False,
        )
    frappe.db.commit()
    print(f"Assigned a Client ID to {len(missing)} existing client(s).")
    return len(missing)

# How many visits a month each class of client is expected to get.
# This is the single source of truth for the mapping — the Customer
# field is derived from it on every save, never typed in.
EXPECTED_VISITS_BY_CLASS = {
    "Supercore": 3,
    "Core": 2,
    "Noncore": 1,
}


def set_expected_visits_from_class(doc, method=None):
    """Customer.validate hook. Keeps expected_visits_per_month in step
    with customer_class so the two can never drift apart. An unclassed
    client gets 0 rather than None — it keeps the field safe to sum
    and compare against without null handling everywhere."""
    doc.expected_visits_per_month = EXPECTED_VISITS_BY_CLASS.get(doc.customer_class, 0)


def enforce_registered_location_lock(doc, method=None):
    """Customer.validate hook. Once registered_latitude/longitude are
    set (locked in by the first Visit for this customer — see
    Visit.after_insert in visit.py), they cannot be changed except by
    a System Manager. Without this, a Delegate Manager editing the
    Customer record could silently move the geofence anchor.

    Gated behind is_geofence_enabled() — off in dev/staging, turned
    on in production via site_config.json."""
    if not is_geofence_enabled():
        return
    if doc.is_new():
        return

    before = doc.get_doc_before_save()
    if not before:
        return

    changed = (
        (before.registered_latitude or None) != (doc.registered_latitude or None)
        or (before.registered_longitude or None) != (doc.registered_longitude or None)
    )
    if not changed:
        return

    if not (before.registered_latitude and before.registered_longitude):
        # Wasn't locked yet — being set for the first time outside the
        # normal Visit flow (e.g. a manager pre-filling it). Allowed.
        return

    if "System Manager" not in frappe.get_roles(frappe.session.user):
        frappe.throw(
            _(
                "This customer's registered visit location is locked and can't be changed. "
                "It was set automatically from the first logged Visit. Only a System Manager "
                "can correct it."
            ),
            title=_("Registered Location Locked"),
        )
