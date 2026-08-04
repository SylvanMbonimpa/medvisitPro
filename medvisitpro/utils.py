import math

import frappe

# Master switch for the whole geofencing feature (locking a customer's
# location on their first visit, blocking later visits outside the
# radius, and locking that field against edits). Off by default —
# turn on in a given site's site_config.json with:
#   "medvisitpro_enforce_geofence": 1
# Deliberately a site config key rather than a Customer/Settings
# field: it's an environment-level rollout switch (dev/staging vs
# production), not data anyone edits through the app.
def is_geofence_enabled():
    return bool(frappe.conf.get("medvisitpro_enforce_geofence"))


# DEV-ONLY escape hatch for the precise-GPS gate. Off by default —
# turn on in a given site's site_config.json with:
#   "medvisitpro_relax_location_gate": 1
# Intended for laptop/desktop testing, where there's no GPS radio and
# the browser only ever returns coarse network/IP positioning that the
# normal <=50m accuracy ceiling (REQUIRED_LOCATION_ACCURACY_METERS)
# rejects outright. When on, any captured location is accepted so the
# visit flow can be exercised end-to-end.
# NEVER enable in production: it lets an approximate, off-site location
# satisfy the on-site check-in requirement. Same env-switch rationale
# as is_geofence_enabled() — a rollout switch, not app-editable data.
def is_location_gate_relaxed():
    return bool(frappe.conf.get("medvisitpro_relax_location_gate"))


# How close a Visit's check-in must be to the customer's locked
# registered location to be accepted. Both readings are already
# individually accuracy-gated to <=50m (see REQUIRED_LOCATION_ACCURACY_METERS
# in api.py/visit.py), so worst case they can differ by ~100m even when the
# delegate is legitimately on-site — 200m leaves buffer for that plus normal
# building/parking-lot footprint.
GEOFENCE_RADIUS_METERS = 200

EARTH_RADIUS_METERS = 6371000


def haversine_distance_meters(lat1, lng1, lat2, lng2):
    """Great-circle distance between two lat/lng points, in meters."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lng2 - lng1)

    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return EARTH_RADIUS_METERS * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# ============================================================
# Brand responsibility
# ============================================================
# Delegates and delegate managers both carry a list of brands (the
# medvisitpro_brands child table on User — see setup_custom_fields.py).
# A manager may only see delegates whose brands overlap their own.
#
# Brand lives on the person, not on the product: a delegate sells a
# principal's portfolio, and the same visit counts toward every brand
# they carry. That means a rep holding two brands contributes to both
# brands' figures — deliberate, since the visit really was made on
# behalf of both.


def user_brands(user):
    """The brands a delegate or manager is responsible for."""
    return frappe.get_all(
        "Delegate Brand",
        filters={"parent": user, "parenttype": "User"},
        pluck="brand",
    )


def manager_sees_all_brands(manager):
    """A manager with no brands assigned sees everything.

    This is what keeps the feature safe to roll out: until someone is
    given brands they behave exactly as they did before scoping existed,
    so enabling the fields doesn't silently blank out live dashboards.
    Assigning a manager their first brand is the act that narrows them.
    """
    return not user_brands(manager)


def delegates_visible_to(manager):
    """Delegate users this manager is allowed to see, or None for all.

    None rather than "every delegate" so callers can skip the filter
    entirely — an `IN` clause listing every delegate on the site is both
    slower and easy to get subtly wrong as people are added.
    """
    if manager_sees_all_brands(manager):
        return None

    brands = set(user_brands(manager))
    delegate_users = frappe.get_all(
        "Has Role", filters={"role": "Delegate", "parenttype": "User"}, pluck="parent"
    )
    if not delegate_users:
        return []

    rows = frappe.get_all(
        "Delegate Brand",
        filters={"parent": ["in", delegate_users], "parenttype": "User"},
        fields=["parent", "brand"],
    )
    visible = {r.parent for r in rows if r.brand in brands}
    return sorted(visible)


def manager_role_label(user):
    """Display label for the manager topbar/profile menu. 'Regional
    Manager' when that role is present — it's the superset (see
    enforce_regional_manager_bundle in user_hooks.py, which guarantees
    every Regional Manager also carries Delegate Manager underneath) —
    else 'Delegate Manager'."""
    return "Regional Manager" if "Regional Manager" in frappe.get_roles(user) else "Delegate Manager"


# Rwanda's real administrative structure: 5 provinces, 30 districts.
# Hardcoded the same way EXPECTED_VISITS_BY_CLASS is — this deployment
# is Rwanda-only (see SUBSCRIBER_DIGITS in api.py for the same
# assumption on phone numbers), and a fixed list is what lets District
# be validated against Province rather than typed free-text.
PROVINCE_DISTRICTS = {
    "Kigali City": ["Gasabo", "Kicukiro", "Nyarugenge"],
    "Northern": ["Burera", "Gakenke", "Gicumbi", "Musanze", "Rulindo"],
    "Southern": ["Gisagara", "Huye", "Kamonyi", "Muhanga", "Nyamagabe", "Nyanza", "Nyaruguru", "Ruhango"],
    "Eastern": ["Bugesera", "Gatsibo", "Kayonza", "Kirehe", "Ngoma", "Nyagatare", "Rwamagana"],
    "Western": ["Karongi", "Ngororero", "Nyabihu", "Nyamasheke", "Rubavu", "Rusizi", "Rutsiro"],
}


def customer_has_registered_location(customer):
    """Whether this customer already has a locked reference location
    (i.e. this would NOT be their first Visit). Used to scope the
    strict accuracy ceiling (REQUIRED_LOCATION_ACCURACY_METERS) to
    visits after the first — the first Visit for a customer is what
    *sets* the reference point, so there's nothing yet to hold it to
    the same tight ceiling against. It still has to be a genuine GPS
    reading with a real accuracy figure, just not necessarily <=50m."""
    registered = frappe.db.get_value(
        "Customer", customer, ["registered_latitude", "registered_longitude"]
    )
    return bool(registered and registered[0] and registered[1])
