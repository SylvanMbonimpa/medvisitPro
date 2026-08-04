import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

from medvisitpro.utils import PROVINCE_DISTRICTS

_PROVINCE_OPTIONS = "\n" + "\n".join(PROVINCE_DISTRICTS.keys())
_DISTRICT_OPTIONS = "\n" + "\n".join(d for districts in PROVINCE_DISTRICTS.values() for d in districts)

# Same 5 names as PROVINCE_DISTRICTS' keys, deliberately — it's what lets
# "which clients fall in this delegate's territory" be a plain
# Customer.province == Territory.name comparison (see bulk_assign_clients
# in api.py) rather than needing a separate territory-to-province map.
RWANDA_TERRITORIES = list(PROVINCE_DISTRICTS.keys())


def add_medvisitpro_customer_fields():
    """Run once (see instructions below). Idempotent — safe to run
    more than once, Frappe skips fields that already exist."""
    create_custom_fields(
        {
            "Customer": [
                {
                    "fieldname": "medvisitpro_client_id",
                    "label": "Client ID",
                    "fieldtype": "Data",
                    "insert_after": "customer_name",
                    "read_only": 1,
                    "unique": 1,
                    "no_copy": 1,
                    "description": (
                        "Stable identifier for this client, assigned automatically "
                        "(MVP-00001). This is the key the spreadsheet import matches "
                        "on to UPDATE a client instead of creating a second copy of "
                        "them. Unlike the record name it survives a rename, so it is "
                        "safe to keep in an external system."
                    ),
                },
                {
                    "fieldname": "is_medvisitpro_enabled",
                    "label": "MedvisitPro Enabled",
                    "fieldtype": "Check",
                    "default": "0",
                    "insert_after": "customer_name",
                    "description": (
                        "Only customers with this checked appear in "
                        "MedvisitPro's delegate/manager pickers and reports. "
                        "Lets this app scope itself to a subset of your "
                        "full Customer list without a separate doctype."
                    ),
                },
                {
                    "fieldname": "customer_category",
                    "label": "Customer Category",
                    "fieldtype": "Select",
                    "options": "\nPharmacy\nClinic\nHospital",
                    "insert_after": "is_medvisitpro_enabled",
                    "description": (
                        "What kind of outlet this is. Used by the Manager "
                        "dashboard's Category Report. Leave blank for "
                        "customers that don't fit any of these — they'll "
                        "show up as 'Uncategorized' in reports. Separate "
                        "from Client Class, which is about visit frequency."
                    ),
                },
                {
                    "fieldname": "customer_class",
                    "label": "Client Class",
                    "fieldtype": "Select",
                    "options": "\nSupercore\nCore\nNoncore",
                    "insert_after": "customer_category",
                    "description": (
                        "How much attention this client warrants. Drives "
                        "Expected Visits/Month: Supercore 3, Core 2, "
                        "Noncore 1."
                    ),
                },
                {
                    "fieldname": "expected_visits_per_month",
                    "label": "Expected Visits / Month",
                    "fieldtype": "Int",
                    "insert_after": "customer_class",
                    "read_only": 1,
                    "description": (
                        "Derived from Client Class, never typed in — see "
                        "set_expected_visits_from_class in customer_hooks.py. "
                        "Change the class and this follows."
                    ),
                },
                {
                    "fieldname": "registered_location_section",
                    "label": "Registered Visit Location",
                    "fieldtype": "Section Break",
                    "insert_after": "expected_visits_per_month",
                },
                {
                    "fieldname": "registered_latitude",
                    "label": "Registered Latitude",
                    "fieldtype": "Data",
                    "insert_after": "registered_location_section",
                    "description": (
                        "Locked automatically from the first Visit ever logged for this "
                        "customer — every later Visit must be within MedvisitPro's geofence "
                        "radius of this point. Cannot be changed except by a System Manager "
                        "(e.g. to correct a bad first reading, or if the client relocates)."
                    ),
                },
                {
                    "fieldname": "registered_longitude",
                    "label": "Registered Longitude",
                    "fieldtype": "Data",
                    "insert_after": "registered_latitude",
                },
                {
                    "fieldname": "registered_location_visit",
                    "label": "Set By Visit",
                    "fieldtype": "Link",
                    "options": "Visit",
                    "insert_after": "registered_longitude",
                    "read_only": 1,
                    "description": "The Visit whose check-in location was locked in as this customer's registered location.",
                },
                {
                    "fieldname": "registered_location_locked_on",
                    "label": "Locked On",
                    "fieldtype": "Datetime",
                    "insert_after": "registered_location_visit",
                    "read_only": 1,
                },
                {
                    "fieldname": "assignment_section",
                    "label": "Delegate Assignment",
                    "fieldtype": "Section Break",
                    "insert_after": "registered_location_locked_on",
                    "collapsible": 1,
                },
                {
                    "fieldname": "assigned_delegate",
                    "label": "Assigned Delegate",
                    "fieldtype": "Link",
                    "options": "User",
                    "insert_after": "assignment_section",
                    "description": "Who owns this account. Set via the client detail modal or the client import — see assign_client in api.py.",
                },
                {
                    "fieldname": "assigned_on",
                    "label": "Assigned On",
                    "fieldtype": "Datetime",
                    "insert_after": "assigned_delegate",
                    "read_only": 1,
                },
                {
                    "fieldname": "assigned_by",
                    "label": "Assigned By",
                    "fieldtype": "Link",
                    "options": "User",
                    "insert_after": "assigned_on",
                    "read_only": 1,
                },
                {
                    "fieldname": "province",
                    "label": "Province",
                    "fieldtype": "Select",
                    "options": _PROVINCE_OPTIONS,
                    "insert_after": "assigned_by",
                },
                {
                    "fieldname": "district",
                    "label": "District",
                    "fieldtype": "Select",
                    "options": _DISTRICT_OPTIONS,
                    "insert_after": "province",
                    "description": "See PROVINCE_DISTRICTS in utils.py for which districts belong to which province.",
                },
            ]
        }
    )
    frappe.db.commit()
    print(
        "Custom fields 'is_medvisitpro_enabled', 'customer_category', "
        "'customer_class', 'expected_visits_per_month', and the "
        "registered-location fields added to Customer."
    )


def add_medvisitpro_user_fields():
    """Brand responsibility and territory assignment for delegates and
    delegate managers. Run once; idempotent like the Customer fields.

    Both roles hang off the same User fields on purpose — a manager is
    responsible for the same brands their delegates sell, and scoping
    reads the identical field on both sides.
    """
    create_custom_fields(
        {
            "User": [
                {
                    "fieldname": "medvisitpro_section",
                    "label": "MedvisitPro Field Assignment",
                    "fieldtype": "Section Break",
                    "insert_after": "last_name",
                    "collapsible": 1,
                },
                {
                    "fieldname": "medvisitpro_brands",
                    "label": "Brands",
                    "fieldtype": "Table",
                    "options": "Delegate Brand",
                    "insert_after": "medvisitpro_section",
                    "description": (
                        "Which brands this person is responsible for. A "
                        "delegate's visits count toward every brand listed "
                        "here; a delegate manager only sees delegates whose "
                        "brands overlap their own. Leave empty on a manager "
                        "to give them sight of every brand.\n\n"
                        "On a plain Delegate this is locked to whichever "
                        "manager created them (see medvisitpro_manager) — "
                        "edited by changing the manager's own brands, not "
                        "this table directly. See create_delegate/"
                        "update_delegate in api.py."
                    ),
                },
                {
                    "fieldname": "medvisitpro_manager",
                    "label": "Manager",
                    "fieldtype": "Link",
                    "options": "User",
                    "insert_after": "medvisitpro_brands",
                    "read_only": 1,
                    "description": (
                        "The Delegate Manager who created this delegate. "
                        "Drives brand inheritance: this delegate's Brands "
                        "always mirror this manager's — reassign by a "
                        "Regional Manager or System Manager only. Blank on "
                        "a delegate created before this field existed, and "
                        "on managers themselves."
                    ),
                },
                {
                    "fieldname": "primary_territory",
                    "label": "Primary Territory",
                    "fieldtype": "Link",
                    "options": "Territory",
                    "insert_after": "medvisitpro_manager",
                    "description": "The delegate's main working area.",
                },
                {
                    "fieldname": "secondary_territory",
                    "label": "Secondary Territory",
                    "fieldtype": "Link",
                    "options": "Territory",
                    "insert_after": "primary_territory",
                    "description": (
                        "Must be outside Kigali — this field exists to make "
                        "sure every delegate also covers ground upcountry. "
                        "Enforced on save; see enforce_secondary_territory "
                        "in user_hooks.py."
                    ),
                },
            ]
        }
    )
    frappe.db.commit()
    print(
        "Custom fields 'medvisitpro_brands', 'primary_territory' and "
        "'secondary_territory' added to User."
    )


def setup_territories():
    """One Territory per Rwandan province, named to match
    PROVINCE_DISTRICTS exactly. Renames the stock 'Kigali' territory
    to 'Kigali City' rather than creating a second one alongside it —
    a delegate's primary_territory may already point at 'Kigali', and
    a rename carries that reference forward instead of orphaning it.
    Idempotent; safe to run more than once."""
    if frappe.db.exists("Territory", "Kigali") and not frappe.db.exists("Territory", "Kigali City"):
        frappe.rename_doc("Territory", "Kigali", "Kigali City")

    for name in RWANDA_TERRITORIES:
        if not frappe.db.exists("Territory", name):
            frappe.get_doc({
                "doctype": "Territory",
                "territory_name": name,
                "parent_territory": "All Territories",
                "is_group": 0,
            }).insert(ignore_permissions=True)
    frappe.db.commit()
    print(f"Territories ready: {', '.join(RWANDA_TERRITORIES)}.")


def setup_roles():
    """The Regional Manager role: creates other Delegate Managers and
    sets their brands (see _require_regional_manager in api.py). Always
    granted alongside Delegate Manager (create_delegate/update_delegate
    do that at the point a user is given the role) so every existing
    Delegate-Manager-gated method and DocType permission keeps working
    unchanged. Idempotent; safe to run more than once."""
    if not frappe.db.exists("Role", "Regional Manager"):
        frappe.get_doc({
            "doctype": "Role",
            "role_name": "Regional Manager",
            "desk_access": 1,
        }).insert(ignore_permissions=True)
    frappe.db.commit()
    print("Role 'Regional Manager' ready.")


def setup_all():
    """Everything this app adds to stock ERPNext doctypes."""
    from medvisitpro.customer_hooks import backfill_client_ids

    add_medvisitpro_customer_fields()
    add_medvisitpro_user_fields()
    # Must run after the field exists, and before anyone tries to import
    # against clients that have no ID to match on.
    backfill_client_ids()
    setup_territories()
    setup_roles()
