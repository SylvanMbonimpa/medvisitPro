import json
import re

import frappe
from frappe import _
from frappe.utils import (
    add_days,
    add_months,
    flt,
    get_first_day,
    get_last_day,
    getdate,
    now_datetime,
    nowdate,
    nowtime,
)

from medvisitpro.customer_hooks import EXPECTED_VISITS_BY_CLASS
from medvisitpro.utils import (
    GEOFENCE_RADIUS_METERS,
    PROVINCE_DISTRICTS,
    customer_has_registered_location,
    delegates_visible_to,
    haversine_distance_meters,
    is_geofence_enabled,
    is_location_gate_relaxed,
    user_brands,
)


REQUIRED_LOCATION_ACCURACY_METERS = 50


def _validate_precise_location(latitude, longitude, accuracy, location_source, customer):
    """A Visit may only be logged with a genuine GPS fix — approximate
    (IP-based) or unverified-accuracy readings are rejected outright
    here, not just flagged. This is the real, unbypassable gate for
    new visits (mirrored in Visit.validate() in visit.py in case a
    Visit is ever created some other way).

    The strict <=50m accuracy ceiling only applies once this customer
    already has a registered reference location — i.e. this isn't
    their first Visit. The first Visit is what *sets* that reference
    point, so it has nothing to be held to that ceiling against yet;
    it still has to be a real GPS reading with a genuine accuracy
    figure, just not necessarily under 50m.

    Returns the accuracy as a float once validated, so the caller
    doesn't need to re-parse client input."""
    if not latitude or not longitude:
        frappe.throw(_("Location is required to log this visit."))

    try:
        accuracy_value = float(accuracy) if accuracy not in (None, "") else None
    except (TypeError, ValueError):
        accuracy_value = None

    # Dev/testing escape hatch (off in production): accept whatever
    # location the browser could supply, skipping the GPS/precision
    # gate. See is_location_gate_relaxed() for why this exists.
    if is_location_gate_relaxed():
        return accuracy_value

    if location_source != "GPS" or accuracy_value is None or accuracy_value <= 0:
        frappe.throw(
            _(
                "A genuine GPS location is required to log this visit. Approximate or "
                "unverified-accuracy locations are not accepted — enable GPS / High Accuracy "
                "location mode and try again."
            ),
            title=_("Location Not Precise Enough"),
        )

    if customer_has_registered_location(customer) and accuracy_value > REQUIRED_LOCATION_ACCURACY_METERS:
        frappe.throw(
            _(
                "A precise GPS location (accuracy of {0}m or better) is required to log this "
                "visit. Approximate or low-accuracy locations are not accepted — enable GPS / "
                "High Accuracy location mode and try again."
            ).format(REQUIRED_LOCATION_ACCURACY_METERS),
            title=_("Location Not Precise Enough"),
        )

    return accuracy_value


def _validate_geofence(customer, latitude, longitude):
    """Friendly early check mirroring Visit.enforce_geofence() in
    visit.py, the real gate. A customer with no locked location yet
    (i.e. this is their first Visit) has nothing to check against —
    this Visit is what sets the lock.

    Gated behind is_geofence_enabled() — off in dev/staging, turned
    on in production via site_config.json."""
    if not is_geofence_enabled():
        return

    registered = frappe.db.get_value(
        "Customer", customer, ["registered_latitude", "registered_longitude"]
    )
    if not registered or not registered[0] or not registered[1]:
        return

    distance = haversine_distance_meters(
        float(latitude), float(longitude), float(registered[0]), float(registered[1])
    )
    if distance > GEOFENCE_RADIUS_METERS:
        frappe.throw(
            _("You appear to be about {0}m from this client's registered location. Visits must "
              "be logged within {1}m of the client's site.").format(round(distance), GEOFENCE_RADIUS_METERS),
            title=_("Not At Client Location"),
        )


def _require_delegate():
    """Every delegate-only method uses this. Centralizing the check
    means it can't drift between methods."""
    if "Delegate" not in frappe.get_roles(frappe.session.user):
        frappe.throw(_("Not permitted"), frappe.PermissionError)


def _require_manager():
    if "Delegate Manager" not in frappe.get_roles(frappe.session.user):
        frappe.throw(_("Not permitted"), frappe.PermissionError)


def _require_regional_manager():
    """Gates creating a Delegate Manager and setting/editing a Delegate
    Manager's brands — see create_delegate/update_delegate. A Regional
    Manager always also carries the Delegate Manager role (granted
    alongside it wherever this role is assigned), so this is strictly
    additive on top of _require_manager, not a replacement for it."""
    if "Regional Manager" not in frappe.get_roles(frappe.session.user):
        frappe.throw(_("Only a Regional Manager can do that."), frappe.PermissionError)


def _require_admin_or_regional_manager():
    """Gates restoring an archived Visit Assignment — see
    restore_visit_assignment. Any Delegate Manager can archive a row
    (soft-delete it off Visit History), but undoing that is kept to a
    smaller set of people, the same reasoning as everything else
    gated behind _require_regional_manager: undoing a records-history
    action shouldn't be as casual as taking it."""
    roles = frappe.get_roles(frappe.session.user)
    if "System Manager" not in roles and "Regional Manager" not in roles:
        frappe.throw(_("Only a Regional Manager or System Manager can do that."), frappe.PermissionError)


def _require_delegate_or_manager():
    roles = frappe.get_roles(frappe.session.user)
    if "Delegate" not in roles and "Delegate Manager" not in roles:
        frappe.throw(_("Not permitted"), frappe.PermissionError)


def _is_plain_delegate(user):
    """True for someone who actually does field visits, as opposed to a
    Delegate Manager who merely also carries the Delegate role (see
    enforce_manager_role_bundle in user_hooks.py — every manager has
    Delegate underneath so the Delegates list/edit UI can see them).
    Clients only ever get assigned to the former: a manager isn't a
    field rep, has no territory, and shouldn't turn up in a client's
    "assigned to" picker just because the role bundle makes them
    technically a Delegate too."""
    roles = frappe.get_roles(user)
    return "Delegate" in roles and "Delegate Manager" not in roles


# ------------------------------------------------------------
# Brand scoping
# ------------------------------------------------------------
# A manager only sees delegates whose brands overlap their own. This is
# a permission boundary, not a display filter — it is applied in the
# queries below rather than in the UI, because every one of these
# methods is reachable directly over /api/method/.


def _scoped_visit_filters(filters):
    """Append the manager's delegate restriction to a list-style filter.

    `["delegate", "in", []]` would match everything in Frappe, so a
    manager who can see nobody gets a sentinel that matches nothing."""
    visible = _visible_delegates()
    if visible is not None:
        filters = filters + [["delegate", "in", visible or [""]]]
    return filters


def _visible_delegates():
    """Delegates the logged-in manager may see, or None for all of them."""
    return delegates_visible_to(frappe.session.user)


def _scope_to_delegates(filters, field="delegate"):
    """Add a delegate restriction to a frappe.get_all filters dict.

    Returns None when the manager can see nobody, which callers treat as
    "return nothing" — distinct from an unscoped manager, who gets no
    filter added at all."""
    visible = _visible_delegates()
    if visible is None:
        return filters
    if not visible:
        return None
    filters[field] = ["in", visible]
    return filters


def _assert_delegate_visible(delegate):
    """Guard for anything that acts on one delegate's data."""
    visible = _visible_delegates()
    if visible is not None and delegate not in visible:
        frappe.throw(
            _("That delegate isn't one of yours — they don't share any of your brands."),
            frappe.PermissionError,
        )


def _week_start(date=None):
    date = getdate(date or nowdate())
    return add_days(date, -date.weekday())


def _analytics_range(period="week", anchor=None):
    """Resolve an analytics filter into (start, end, num_weeks).

    `start`/`end` are inclusive calendar dates; callers query with an
    exclusive upper bound (< end + 1 day) so the whole `end` day counts.
    `num_weeks` is the divisor that keeps the per-client-per-week
    averages comparable no matter how wide the window is.

    - "week":  Monday..Saturday of the week containing `anchor`.
    - "month": 1st..last day of `anchor`'s month.
    - "year":  Jan 1..Dec 31 of `anchor`'s year.
    """
    anchor = getdate(anchor or nowdate())

    if period == "month":
        start = get_first_day(anchor)
        end = get_last_day(anchor)
    elif period == "year":
        start = anchor.replace(month=1, day=1)
        end = anchor.replace(month=12, day=31)
    else:  # "week"
        start = _week_start(anchor)
        end = add_days(start, 5)  # Monday..Saturday

    if period == "week":
        num_weeks = 1.0
    else:
        num_weeks = max(1.0, ((end - start).days + 1) / 7.0)

    return start, end, num_weeks


def _customer_address(customer):
    address_name = frappe.db.get_value(
        "Dynamic Link",
        {"link_doctype": "Customer", "link_name": customer, "parenttype": "Address"},
        "parent",
    )
    if not address_name:
        return ""
    return frappe.db.get_value("Address", address_name, "address_line1") or ""


def _customer_contact_name(customer):
    """The Contact record name linked to this client, or None."""
    return frappe.db.get_value(
        "Dynamic Link",
        {"link_doctype": "Customer", "link_name": customer, "parenttype": "Contact"},
        "parent",
    )


def _customer_phone(customer):
    contact_name = _customer_contact_name(customer)
    if not contact_name:
        return ""
    contact = frappe.db.get_value("Contact", contact_name, ["mobile_no", "phone"], as_dict=True)
    if not contact:
        return ""
    return contact.mobile_no or contact.phone or ""


def _customer_email(customer):
    """This client's email, read from their linked Contact — the
    email_ids child table, same shape as phone_nos. Prefers the row
    flagged is_primary, else whichever comes first."""
    contact_name = _customer_contact_name(customer)
    if not contact_name:
        return ""
    rows = frappe.get_all(
        "Contact Email",
        filters={"parent": contact_name, "parenttype": "Contact"},
        fields=["email_id", "is_primary"],
        order_by="is_primary desc, idx asc",
        limit_page_length=1,
    )
    return rows[0].email_id if rows else ""


def _contact_display_name(contact):
    """Human-readable name for a Contact, falling back to its id."""
    if not contact:
        return ""
    full_name = frappe.db.get_value("Contact", contact, "name")
    doc = frappe.db.get_value(
        "Contact", contact, ["first_name", "last_name", "designation"], as_dict=True
    )
    if not doc:
        return contact
    name = " ".join(filter(None, [doc.first_name, doc.last_name])).strip()
    return name or full_name or contact


@frappe.whitelist()
def get_customer_contacts(customer):
    """Points of contact on file for one client — a doctor, a
    pharmacist, whoever the business actually goes through. Powers the
    picker next to the client on a plan line.

    Every client created through this app gets one Contact from its
    phone number, so this is rarely empty; it still can be for clients
    imported or created outside the app, which is why picking one is
    optional everywhere."""
    _require_delegate_or_manager()

    names = frappe.get_all(
        "Dynamic Link",
        filters={"link_doctype": "Customer", "link_name": customer, "parenttype": "Contact"},
        pluck="parent",
    )
    if not names:
        return []

    contacts = frappe.get_all(
        "Contact",
        filters={"name": ["in", names]},
        fields=["name", "first_name", "last_name", "designation", "mobile_no", "phone", "modified_by"],
        order_by="first_name asc",
    )
    for c in contacts:
        c["display_name"] = (
            " ".join(filter(None, [c.first_name, c.last_name])).strip() or c.name
        )
        c["phone"] = c.mobile_no or c.phone or ""
        # Same lookup as _customer_email, just scoped to this one
        # Contact rather than a Customer's linked one — most points of
        # contact were added without an email at all, so this is
        # usually blank.
        email_row = frappe.get_all(
            "Contact Email", filters={"parent": c.name, "parenttype": "Contact"},
            fields=["email_id", "is_primary"], order_by="is_primary desc, idx asc", limit_page_length=1,
        )
        c["email"] = email_row[0].email_id if email_row else ""
    return contacts


def _attach_checkin_coords(assignment_dict):
    """If this assignment has a linked Visit (i.e. it's Completed),
    pull the check-in coordinates onto the assignment dict so
    dashboard cards can render a 'View on Map' link without a
    separate API call per card."""
    if not assignment_dict.get("visit"):
        return
    coords = frappe.db.get_value(
        "Visit",
        assignment_dict["visit"],
        ["checkin_latitude", "checkin_longitude", "checkin_accuracy", "checkin_location_source"],
        as_dict=True,
    )
    if coords:
        assignment_dict["checkin_latitude"] = coords.checkin_latitude
        assignment_dict["checkin_longitude"] = coords.checkin_longitude
        assignment_dict["checkin_accuracy"] = coords.checkin_accuracy
        assignment_dict["checkin_location_source"] = coords.checkin_location_source


@frappe.whitelist()
def get_week_assignments(week_start_date=None):
    """All Visit Assignments for the logged-in delegate for one week
    (defaults to the current week). Powers the whole dashboard —
    day tabs and status filters both operate client-side on this
    single payload rather than re-fetching per click."""
    _require_delegate()

    week_start_date = _week_start(week_start_date)

    assignments = frappe.get_all(
        "Visit Assignment",
        filters={
            "delegate": frappe.session.user,
            "week_start_date": week_start_date,
        },
        fields=[
            "name", "customer", "contact_person", "scheduled_date",
            "scheduled_time", "status", "visit",
        ],
        order_by="scheduled_date asc, scheduled_time asc",
    )

    for a in assignments:
        customer_name = frappe.db.get_value("Customer", a.customer, "customer_name")
        a["customer_name"] = customer_name or a.customer
        a["contact_person_name"] = _contact_display_name(a.contact_person)
        a["address"] = _customer_address(a.customer)
        a["scheduled_date"] = str(a.scheduled_date) if a.scheduled_date else None
        a["scheduled_time"] = str(a.scheduled_time) if a.scheduled_time else None
        # Lets the client-side location gate know whether the strict
        # accuracy ceiling applies to this particular visit — it
        # doesn't for a customer's first-ever visit (see
        # _validate_precise_location for why).
        a["customer_has_prior_location"] = customer_has_registered_location(a.customer)
        _attach_checkin_coords(a)

    return {
        "week_start_date": str(week_start_date),
        "assignments": assignments,
        "total": len(assignments),
        "completed": len([a for a in assignments if a.status == "Completed"]),
    }


@frappe.whitelist()
def get_items(txt=""):
    """Small product picker list for the visit form. Includes each
    item's selling `rate` so the form can preview order line totals
    without the delegate ever typing a price."""
    _require_delegate()
    filters = {"disabled": 0}
    if txt:
        filters["item_name"] = ["like", f"%{txt}%"]
    items = frappe.get_all("Item", filters=filters, fields=["name", "item_name"], limit_page_length=50)
    for it in items:
        it["rate"] = _item_selling_rate(it["name"])
    return items


@frappe.whitelist()
def search_customers(txt=""):
    """Used by both the delegate's 'Add New Client Visit' picker and
    the manager's 'Assign New Visit' picker. Scoped to customers
    explicitly flagged for this program — see is_medvisitpro_enabled
    on Customer.

    customer_category/expected_visits_per_month ride along so a
    delegate planning a visit sees the Org-Type and expected monthly
    cadence right in the picker/plan line, not just the name."""
    _require_delegate_or_manager()

    filters = {"is_medvisitpro_enabled": 1}
    if txt:
        filters["customer_name"] = ["like", f"%{txt}%"]
    return frappe.get_all(
        "Customer",
        filters=filters,
        fields=["name", "customer_name", "customer_category", "expected_visits_per_month"],
        limit_page_length=10,
    )


@frappe.whitelist()
def list_client_names():
    """Every enabled client's name, for the Add Client modal's
    near-duplicate warning — search_customers' LIKE match won't surface
    "Kign Faisal Hospital" as close to "King Faisal Hospital" (neither
    is a substring of the other), so that check runs client-side
    (Levenshtein) against this full list instead. Two fields, fetched
    once per modal session — cheap even at a few thousand clients."""
    _require_manager()
    return frappe.get_all(
        "Customer",
        filters={"is_medvisitpro_enabled": 1},
        fields=["name", "customer_name"],
        limit_page_length=0,
    )


# create_adhoc_assignment used to live here and made the Visit
# Assignment outright, so a delegate could start an unplanned visit
# with no oversight. Ad-hoc visits now go through the same approval
# gate as planned ones — see request_adhoc_visit further down, which
# lodges the request on that week's Weekly Visit Plan instead. The
# assignment only comes into being when the manager approves.


@frappe.whitelist()
def reschedule_visit(assignment, new_date, new_time=None):
    """Delegate has read-only permission on Visit Assignment by design
    (schedules are manager-owned) — rescheduling is only allowed
    through this validated method, and only for their own visits."""
    _require_delegate()

    doc = frappe.get_doc("Visit Assignment", assignment)
    if doc.delegate != frappe.session.user:
        frappe.throw(_("This visit is not assigned to you"), frappe.PermissionError)

    doc.scheduled_date = new_date
    if new_time:
        doc.scheduled_time = new_time
    doc.status = "Pending"
    doc.save(ignore_permissions=True)
    frappe.db.commit()

    return {"ok": True}


# ============================================================
# Product ordering
# ============================================================
# A delegate can place an order for the client straight from the
# visit form: any discussed product given a quantity becomes a line
# on a DRAFT Sales Order linked to the Visit. It's left as a draft on
# purpose — a Delegate Manager reviews and confirms (submits) it via
# confirm_sales_order. Delegates never set pricing; rates come from
# the item's selling price.


def _item_selling_rate(item_code):
    """Best-guess selling rate for an item: the most recent selling
    Item Price, falling back to the item's standard_rate (0 if neither
    is set). Used both to price order lines and to preview line totals
    in the visit form, so the delegate never has to type a price."""
    price = frappe.db.get_value(
        "Item Price",
        {"item_code": item_code, "selling": 1},
        "price_list_rate",
        order_by="valid_from desc",
    )
    if price:
        return flt(price)
    return flt(frappe.db.get_value("Item", item_code, "standard_rate"))


def _default_company():
    return (
        frappe.defaults.get_user_default("Company")
        or frappe.db.get_single_value("Global Defaults", "default_company")
    )


def _create_draft_sales_order(customer, order_lines):
    """Create a DRAFT Sales Order (docstatus 0) for `customer` from
    [{item, qty}] lines, priced from each item's selling rate. Returns
    the new SO name. Raises if no default Company is configured."""
    company = _default_company()
    if not company:
        frappe.throw(_("No default Company is configured, so an order can't be placed. Ask an administrator to set one."))

    delivery = add_days(nowdate(), 7)
    so = frappe.new_doc("Sales Order")
    so.customer = customer
    so.company = company
    so.transaction_date = nowdate()
    so.delivery_date = delivery
    for line in order_lines:
        so.append("items", {
            "item_code": line["item"],
            "qty": line["qty"],
            "rate": _item_selling_rate(line["item"]),
            "delivery_date": delivery,
        })
    so.insert(ignore_permissions=True)  # stays a draft (docstatus 0)
    return so.name


@frappe.whitelist()
def submit_visit(
    assignment,
    latitude,
    longitude,
    discussion_notes,
    outcome,
    products=None,
    accuracy=None,
    location_source=None,
    contact_person=None,
):
    """Create the Visit record. A precise GPS location is required —
    see _validate_precise_location for the accuracy gate — and it
    must also fall within the customer's geofence (_validate_geofence)
    once one is locked in. Both are enforced again inside
    Visit.validate() in visit.py as the real, unbypassable checks for
    new documents."""
    _require_delegate()

    assignment_doc = frappe.get_doc("Visit Assignment", assignment)
    if assignment_doc.delegate != frappe.session.user:
        frappe.throw(_("This visit is not assigned to you"), frappe.PermissionError)

    accuracy_value = _validate_precise_location(
        latitude, longitude, accuracy, location_source, assignment_doc.customer
    )
    _validate_geofence(assignment_doc.customer, latitude, longitude)

    visit = frappe.new_doc("Visit")
    visit.visit_assignment = assignment
    visit.delegate = frappe.session.user
    visit.customer = assignment_doc.customer
    # Whoever was actually seen. Falls back to the person the
    # assignment named, since the planned contact is usually the one
    # available — but the delegate can correct it at check-in.
    visit.contact_person = contact_person or assignment_doc.contact_person
    visit.checkin_latitude = latitude
    visit.checkin_longitude = longitude
    visit.checkin_accuracy = accuracy_value
    visit.checkin_location_source = location_source
    visit.discussion_notes = discussion_notes
    visit.outcome = outcome

    # A product with a positive quantity is being ordered (not just
    # discussed) — collect those into Sales Order lines.
    order_lines = []
    if products:
        products = json.loads(products) if isinstance(products, str) else products
        for p in products:
            item = p.get("item")
            if not item:
                continue
            visit.append("products_discussed", {"item": item, "remarks": p.get("remarks")})
            qty = flt(p.get("qty"))
            if qty > 0:
                order_lines.append({"item": item, "qty": qty})

    visit.insert()

    # Placing the order is opt-in (only when quantities were entered),
    # so a visit with no order still completes exactly as before. The
    # draft SO is created in the same transaction and linked back onto
    # the Visit; if it fails, the whole check-in rolls back and the
    # delegate — still on-site — sees the error and can retry.
    sales_order = None
    if order_lines:
        sales_order = _create_draft_sales_order(visit.customer, order_lines)
        visit.db_set("sales_order", sales_order)

    frappe.db.commit()

    return {"ok": True, "visit": visit.name, "sales_order": sales_order}


# ============================================================
# Manager-facing methods
# ============================================================
# ASSUMPTION: any user with the Delegate Manager role can see and
# manage ALL delegates' visits (flat structure, no per-manager
# territory scoping). If you later need managers to only see their
# own team, add a "reports_to" field on User and filter by it here.


@frappe.whitelist()
def get_team_week_data(week_start_date=None):
    """All Visit Assignments across every delegate for one week.
    Powers the manager dashboard the same way get_week_assignments
    powers the delegate one — one payload, filtered client-side."""
    _require_manager()

    week_start_date = _week_start(week_start_date)

    filters = _scope_to_delegates({"week_start_date": week_start_date})
    if filters is None:
        # Manager has brands, but no delegate carries any of them.
        return {
            "week_start_date": str(week_start_date), "assignments": [],
            "total": 0, "completed": 0, "missed": 0, "adhoc_count": 0,
        }

    assignments = frappe.get_all(
        "Visit Assignment",
        filters=filters,
        fields=[
            "name", "delegate", "customer", "scheduled_date",
            "scheduled_time", "status", "visit_type", "visit",
        ],
        order_by="scheduled_date asc, scheduled_time asc",
    )

    for a in assignments:
        a["customer_name"] = frappe.db.get_value("Customer", a.customer, "customer_name") or a.customer
        a["address"] = _customer_address(a.customer)
        a["phone"] = _customer_phone(a.customer)
        a["delegate_name"] = frappe.db.get_value("User", a.delegate, "full_name") or a.delegate
        a["scheduled_date"] = str(a.scheduled_date) if a.scheduled_date else None
        a["scheduled_time"] = str(a.scheduled_time) if a.scheduled_time else None
        _attach_checkin_coords(a)

    scheduled = [a for a in assignments if a.visit_type == "Scheduled"]

    return {
        "week_start_date": str(week_start_date),
        "assignments": assignments,
        "total": len(scheduled),
        "completed": len([a for a in scheduled if a.status == "Completed"]),
        "missed": len([a for a in scheduled if a.status == "Missed"]),
        "adhoc_count": len(assignments) - len(scheduled),
    }


@frappe.whitelist()
def get_team_analytics(period="week", anchor=None):
    """Simple aggregate numbers for the Analytics section: total
    visits logged, total order value from visits, and a most-visited
    customers ranking, all scoped to the selected window.

    `period` is "week", "month" or "year"; `anchor` is any date inside
    that window (defaults to today). For "week" the anchor is the week
    start (Monday), so the existing no-arg call keeps working."""
    _require_manager()

    start, end, num_weeks = _analytics_range(period, anchor)

    visible = _visible_delegates()
    visit_filters = [
        ["checkin_time", ">=", str(start)],
        ["checkin_time", "<", str(add_days(end, 1))],
    ]
    if visible is not None:
        visit_filters.append(["delegate", "in", visible or [""]])

    visits = frappe.get_all(
        "Visit", filters=visit_filters, fields=["name", "customer", "sales_order"]
    )

    adhoc_filters = [
        ["scheduled_date", ">=", str(start)],
        ["scheduled_date", "<=", str(end)],
        ["visit_type", "!=", "Scheduled"],
    ]
    if visible is not None:
        adhoc_filters.append(["delegate", "in", visible or [""]])
    adhoc_count = frappe.db.count("Visit Assignment", filters=adhoc_filters)

    customer_counts = {}
    for v in visits:
        customer_counts[v.customer] = customer_counts.get(v.customer, 0) + 1

    top_customers = sorted(customer_counts.items(), key=lambda x: x[1], reverse=True)[:5]
    top_customers_named = [
        {"customer": c, "customer_name": frappe.db.get_value("Customer", c, "customer_name") or c, "visits": n}
        for c, n in top_customers
    ]

    total_order_value = 0
    for v in visits:
        if v.sales_order:
            total_order_value += frappe.db.get_value("Sales Order", v.sales_order, "grand_total") or 0

    category_breakdown, category_averages = _category_analytics(visits, num_weeks)

    return {
        "period": period,
        "start": str(start),
        "end": str(end),
        "total_visits": len(visits),
        "adhoc_count": adhoc_count,
        "total_order_value": float(total_order_value),
        "top_customers": top_customers_named,
        "category_breakdown": category_breakdown,
        "category_averages": category_averages,
    }


def _category_analytics(visits, num_weeks=1.0):
    """Breaks visits down by Customer.customer_category (Pharmacy /
    Clinic / blank -> 'Uncategorized'). Returns:
    - category_breakdown: [{category, visits, percent}, ...] for the donut
    - category_averages: {category: avg visits per enabled client per week
      in that category}. Dividing by `num_weeks` keeps this a weekly rate
      whether the window is one week, a month or a year.
    """
    enabled_customers = frappe.get_all(
        "Customer",
        filters={"is_medvisitpro_enabled": 1},
        fields=["name", "customer_category"],
    )
    category_of = {c.name: (c.customer_category or "Uncategorized") for c in enabled_customers}

    client_counts_by_category = {}
    for c in enabled_customers:
        cat = c.customer_category or "Uncategorized"
        client_counts_by_category[cat] = client_counts_by_category.get(cat, 0) + 1

    visit_counts_by_category = {}
    for v in visits:
        cat = category_of.get(v.customer, "Uncategorized")
        visit_counts_by_category[cat] = visit_counts_by_category.get(cat, 0) + 1

    total_category_visits = sum(visit_counts_by_category.values())

    category_breakdown = []
    category_averages = {}
    for cat, visit_count in visit_counts_by_category.items():
        percent = round((visit_count / total_category_visits) * 100, 1) if total_category_visits else 0
        category_breakdown.append({"category": cat, "visits": visit_count, "percent": percent})

        client_count = client_counts_by_category.get(cat, 0)
        category_averages[cat] = (
            round(visit_count / client_count / num_weeks, 1) if client_count else 0
        )

    return category_breakdown, category_averages


# ============================================================
# Manager dashboard summary
# ============================================================
# Backs the top of the manager dashboard — the week-over-week headline,
# the product-conversion card, headcount, the per-delegate performance
# table and the six-month trend.
#
# One method rather than five: every panel on that screen is drawn on
# first paint, so five endpoints would just be five round-trips for one
# view. Each block below is independent, so a panel can be dropped from
# the UI without unpicking the others.

# Order matters — it's the column order of the performance table, from
# the clients that warrant most attention to least. Mirrors
# EXPECTED_VISITS_BY_CLASS in customer_hooks.py.
CLIENT_CLASSES = ("Supercore", "Core", "Noncore")

# How far back the product-conversion card looks. A single week rarely
# holds enough discussions of any one product to make a percentage mean
# anything; a quarter does, and still tracks the current catalogue.
PRODUCT_WINDOW_DAYS = 90

TREND_MONTHS = 6


def _delegate_users():
    """Delegates the logged-in manager may see, with their enabled state.

    Brand-scoped: a manager carrying only AstraZeneca never sees the
    Novartis team, here or anywhere downstream of here."""
    names = frappe.get_all(
        "Has Role", filters={"role": "Delegate", "parenttype": "User"}, pluck="parent"
    )
    visible = _visible_delegates()
    if visible is not None:
        names = [n for n in names if n in set(visible)]
    if not names:
        return []
    return frappe.get_all(
        "User",
        filters={"name": ["in", names]},
        fields=["name", "full_name", "enabled"],
        order_by="full_name asc",
    )


def _initials(full_name, fallback):
    parts = [p for p in (full_name or "").split() if p]
    if not parts:
        return (fallback or "?")[:2].upper()
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def _weekly_completion_headline():
    """Completed visits this week against last week.

    Counts Visit Assignment rather than Visit because `status` is what
    the rest of the dashboard reports on, and an assignment marked
    Completed is exactly one logged visit."""
    this_week = _week_start()
    last_week = add_days(this_week, -7)

    def completed_in(week):
        filters = _scope_to_delegates({"week_start_date": week, "status": "Completed"})
        return frappe.db.count("Visit Assignment", filters) if filters is not None else 0

    this_count = completed_in(this_week)
    last_count = completed_in(last_week)

    # No baseline means no percentage — the UI shows the raw count alone
    # rather than a meaningless "+100%" off a week with no visits.
    delta = None
    if last_count:
        delta = round(((this_count - last_count) / last_count) * 100, 1)

    return {
        "completed": this_count,
        "previous": last_count,
        "delta_percent": delta,
    }


def _product_engagement(window_days=PRODUCT_WINDOW_DAYS):
    """How each product performed on visits over the recent window.

    Returns {item_code: {"discussed": n, "ordered": n}} where both counts
    are numbers of *visits*, not line rows — a product discussed twice on
    one visit still counts once, which is what makes the ratio between
    them a conversion rate.

    'Discussed' is a Visit Product row; 'ordered' is that same item
    appearing on the draft Sales Order raised from the same visit (see
    submit_visit — a product only reaches the order once the delegate
    gives it a quantity)."""
    since = add_days(nowdate(), -window_days)

    visits = frappe.get_all(
        "Visit",
        filters=_scoped_visit_filters([["checkin_time", ">=", str(since)]]),
        fields=["name", "sales_order"],
    )
    if not visits:
        return {}

    visit_names = [v.name for v in visits]
    order_of_visit = {v.name: v.sales_order for v in visits if v.sales_order}

    discussed_rows = frappe.get_all(
        "Visit Product",
        filters={"parent": ["in", visit_names], "parenttype": "Visit"},
        fields=["parent", "item"],
    )
    if not discussed_rows:
        return {}

    # {item: {visit names where it was discussed}}
    discussed = {}
    for row in discussed_rows:
        if row.item:
            discussed.setdefault(row.item, set()).add(row.parent)

    # {sales order: {item codes on it}}
    ordered_items_by_so = {}
    if order_of_visit:
        for row in frappe.get_all(
            "Sales Order Item",
            filters={"parent": ["in", list(set(order_of_visit.values()))]},
            fields=["parent", "item_code"],
        ):
            ordered_items_by_so.setdefault(row.parent, set()).add(row.item_code)

    engagement = {}
    for item, seen_on in discussed.items():
        converted = 0
        for visit_name in seen_on:
            so = order_of_visit.get(visit_name)
            if so and item in ordered_items_by_so.get(so, ()):
                converted += 1
        engagement[item] = {"discussed": len(seen_on), "ordered": converted}

    return engagement


def _top_product_conversion():
    """The single most-discussed product over the recent window, for the
    dashboard card. Same data as list_products, reduced to one row."""
    engagement = _product_engagement()
    if not engagement:
        return None

    item, stats = max(engagement.items(), key=lambda kv: kv[1]["discussed"])
    total = stats["discussed"]
    ordered_percent = round((stats["ordered"] / total) * 100) if total else 0

    return {
        "item": item,
        "item_name": frappe.db.get_value("Item", item, "item_name") or item,
        "discussed": total,
        "ordered": stats["ordered"],
        "ordered_percent": ordered_percent,
        "declined_percent": 100 - ordered_percent,
        "window_days": PRODUCT_WINDOW_DAYS,
    }


@frappe.whitelist()
def list_products(txt=""):
    """The product catalogue with how each one is actually performing in
    the field — the manager's Products view.

    Reads straight from ERPNext's Item doctype (disabled items excluded),
    joined to the visit-engagement figures above. Ordered most-discussed
    first, so the view answers "what are the reps actually pushing, and
    is it converting" rather than being an alphabetical stock list.

    Items nobody has discussed still appear, at zero — a product getting
    no attention is exactly what a manager needs to see."""
    _require_manager()

    filters = {"disabled": 0}
    if txt:
        filters["item_name"] = ["like", f"%{txt}%"]

    items = frappe.get_all(
        "Item",
        filters=filters,
        fields=["name", "item_name", "item_group", "stock_uom"],
        order_by="item_name asc",
        limit_page_length=500,
    )
    if not items:
        return []

    engagement = _product_engagement()

    rows = []
    for it in items:
        stats = engagement.get(it.name, {"discussed": 0, "ordered": 0})
        discussed = stats["discussed"]
        rows.append({
            "item": it.name,
            "item_name": it.item_name or it.name,
            "item_group": it.item_group or "—",
            "uom": it.stock_uom or "",
            "rate": _item_selling_rate(it.name),
            "discussed": discussed,
            "ordered": stats["ordered"],
            "conversion_percent": (
                round((stats["ordered"] / discussed) * 100) if discussed else None
            ),
        })

    rows.sort(key=lambda r: (-r["discussed"], -r["ordered"], r["item_name"]))
    return {"products": rows, "window_days": PRODUCT_WINDOW_DAYS}


def _delegate_performance(week_start_date):
    """Per-delegate completion for the week, split by client class.

    'Planned' is how many assignments that delegate holds for the week
    in that class, 'done' how many are Completed — so 12/15 reads as
    twelve of the fifteen Core visits they were given. Delegates with
    nothing assigned are still listed, at zero, rather than vanishing
    from the manager's view for the week."""
    filters = _scope_to_delegates({"week_start_date": week_start_date})
    assignments = (
        frappe.get_all(
            "Visit Assignment", filters=filters, fields=["delegate", "customer", "status"]
        )
        if filters is not None
        else []
    )

    customer_names = list({a.customer for a in assignments if a.customer})
    class_of = {}
    if customer_names:
        for c in frappe.get_all(
            "Customer",
            filters={"name": ["in", customer_names]},
            fields=["name", "customer_class"],
        ):
            class_of[c.name] = c.customer_class

    users = _delegate_users()
    blank = lambda: {k: {"done": 0, "planned": 0} for k in CLIENT_CLASSES}
    by_delegate = {u.name: blank() for u in users}

    for a in assignments:
        klass = class_of.get(a.customer)
        if klass not in CLIENT_CLASSES:
            # Unclassed clients are real but have no column to sit in;
            # counting them would make the row totals not add up.
            continue
        bucket = by_delegate.setdefault(a.delegate, blank())
        bucket[klass]["planned"] += 1
        if a.status == "Completed":
            bucket[klass]["done"] += 1

    rows = []
    for u in users:
        classes = by_delegate.get(u.name, blank())
        planned = sum(c["planned"] for c in classes.values())
        done = sum(c["done"] for c in classes.values())
        rows.append({
            "delegate": u.name,
            "delegate_name": u.full_name or u.name,
            "initials": _initials(u.full_name, u.name),
            "enabled": bool(u.enabled),
            "classes": classes,
            "total_planned": planned,
            "total_done": done,
            "completion_percent": round((done / planned) * 100) if planned else 0,
        })

    # Busiest first — that's who the manager is scanning for.
    rows.sort(key=lambda r: (-r["total_planned"], r["delegate_name"]))
    return rows


def _visit_trend():
    """Logged visits per month over the recent window, plus progress
    against an annual target.

    The target is derived, not configured: every enabled client has an
    expected_visits_per_month driven by its class (see
    customer_hooks.py), so the year's target is that sum times twelve.
    It moves as clients are added or reclassified, which is the point —
    a hardcoded number would be stale within a month."""
    today = getdate(nowdate())

    months = []
    for offset in range(TREND_MONTHS - 1, -1, -1):
        anchor = add_months(today, -offset)
        start = get_first_day(anchor)
        end = get_last_day(anchor)
        months.append({
            "label": start.strftime("%b").upper(),
            "month": str(start),
            "visits": frappe.db.count("Visit", filters=_scoped_visit_filters([
                ["checkin_time", ">=", str(start)],
                ["checkin_time", "<", str(add_days(end, 1))],
            ])),
        })

    monthly_expected = sum(
        (c.expected_visits_per_month or 0)
        for c in frappe.get_all(
            "Customer",
            filters={"is_medvisitpro_enabled": 1},
            fields=["expected_visits_per_month"],
        )
    )
    yearly_target = monthly_expected * 12

    year_start = today.replace(month=1, day=1)
    ytd = frappe.db.count(
        "Visit", filters=_scoped_visit_filters([["checkin_time", ">=", str(year_start)]])
    )

    peak = max((m["visits"] for m in months), default=0)
    for m in months:
        # Bar heights are relative to the tallest month, so a quiet
        # period still reads as a shape rather than six flat stubs.
        m["height_percent"] = round((m["visits"] / peak) * 100) if peak else 0

    return {
        "months": months,
        "yearly_target": yearly_target,
        "ytd_visits": ytd,
        "progress_percent": round((ytd / yearly_target) * 100, 1) if yearly_target else 0,
    }


@frappe.whitelist()
def list_manager_brands():
    """Brands the logged-in manager may filter reports by.

    A manager with no brands of their own is unscoped, so they get every
    brand on the system."""
    _require_manager()

    own = user_brands(frappe.session.user)
    if own:
        return sorted(set(own))
    return frappe.get_all("Brand", pluck="name", order_by="name asc")


def _delegates_for_brand(brand):
    """Delegates carrying `brand`, intersected with what the manager may
    see. Returns None when no brand filter is being applied."""
    if not brand:
        return _visible_delegates()

    if brand not in list_manager_brands():
        frappe.throw(_("You don't have access to that brand."), frappe.PermissionError)

    carrying = frappe.get_all(
        "Delegate Brand",
        filters={"brand": brand, "parenttype": "User"},
        pluck="parent",
    )
    visible = _visible_delegates()
    if visible is None:
        return sorted(set(carrying))
    return sorted(set(carrying) & set(visible))


# Months covered by each reporting period, used to scale the monthly
# visit requirement. A week is deliberately None: the cadence rules are
# expressed per month (Supercore 3, Core 2, Noncore 1), and pro-rating
# them to "0.7 visits this week" would invent a target nobody set.
PERIOD_MONTHS = {"week": None, "month": 1, "year": 12}


@frappe.whitelist()
def get_class_coverage(period="month", anchor=None, brand=None):
    """Client coverage by class, for a period and optionally one brand.

    Answers the question the visit cadence exists to enforce: every
    Supercore client should be seen 3 times a month, Core twice, Noncore
    once (EXPECTED_VISITS_BY_CLASS in customer_hooks.py, stored on each
    Customer as expected_visits_per_month). So per class this reports how
    many of those clients were actually reached, how often, and how many
    hit their required number.

    The client population is every MedvisitPro-enabled client in the
    class — the full list that *should* be covered — while the visits
    counted are only those made by in-scope delegates. That way a brand's
    row reads as "of the clients we ought to be covering, this is how
    many my team actually reached".

    Brand comes from the delegate, not the product: a rep carries a
    principal's portfolio, so their visits count toward every brand they
    hold. A rep carrying two brands therefore contributes to both rows.
    """
    _require_manager()

    start, end, _num_weeks = _analytics_range(period, anchor)
    months = PERIOD_MONTHS.get(period, 1)

    delegates = _delegates_for_brand(brand)
    # None = unrestricted. An empty list means nobody qualifies, which
    # must yield zero visits rather than every visit.
    visit_filters = [
        ["checkin_time", ">=", str(start)],
        ["checkin_time", "<", str(add_days(end, 1))],
    ]
    if delegates is not None:
        visit_filters.append(["delegate", "in", delegates or [""]])

    visits = frappe.get_all("Visit", filters=visit_filters, fields=["customer"])

    visits_per_customer = {}
    for v in visits:
        visits_per_customer[v.customer] = visits_per_customer.get(v.customer, 0) + 1

    customers = frappe.get_all(
        "Customer",
        filters={"is_medvisitpro_enabled": 1},
        fields=["name", "customer_class", "expected_visits_per_month"],
    )

    rows = []
    for klass in CLIENT_CLASSES:
        in_class = [c for c in customers if c.customer_class == klass]
        per_month = EXPECTED_VISITS_BY_CLASS.get(klass, 0)
        required_each = per_month * months if months else None

        visited = [c for c in in_class if visits_per_customer.get(c.name)]
        total_visits = sum(visits_per_customer.get(c.name, 0) for c in in_class)

        on_target = (
            len([c for c in in_class if visits_per_customer.get(c.name, 0) >= required_each])
            if required_each
            else None
        )

        rows.append({
            "customer_class": klass,
            "clients": len(in_class),
            "clients_visited": len(visited),
            "visits": total_visits,
            "required_per_client": required_each,
            "required_total": required_each * len(in_class) if required_each else None,
            "clients_on_target": on_target,
            "coverage_percent": (
                round((len(visited) / len(in_class)) * 100) if in_class else 0
            ),
            "compliance_percent": (
                round((on_target / len(in_class)) * 100)
                if required_each and in_class
                else None
            ),
        })

    unclassed = len([c for c in customers if c.customer_class not in CLIENT_CLASSES])

    return {
        "period": period,
        "start": str(start),
        "end": str(end),
        "months": months,
        "brand": brand or None,
        "rows": rows,
        "totals": {
            "clients": sum(r["clients"] for r in rows),
            "clients_visited": sum(r["clients_visited"] for r in rows),
            "visits": sum(r["visits"] for r in rows),
        },
        # Surfaced rather than hidden: a client with no class has no
        # cadence to be measured against, and right now that is most of
        # them. Silently dropping them would make coverage look complete.
        "unclassed_clients": unclassed,
    }


@frappe.whitelist()
def get_visit_trend():
    """The six-month trend and annual-target progress, for /report.

    Separate from get_manager_dashboard because the two are consumed by
    different pages now — the dashboard is operational and doesn't show
    a six-month view, so it shouldn't pay for six count queries and a
    full scan of enabled clients on every load."""
    _require_manager()
    return _visit_trend()


@frappe.whitelist()
def get_manager_dashboard(week_start_date=None):
    """Everything the manager dashboard's summary panels need.

    The trend lives in get_visit_trend() and is rendered on /report."""
    _require_manager()

    week_start_date = _week_start(week_start_date)
    users = _delegate_users()
    active = len([u for u in users if u.enabled])

    return {
        "week_start_date": str(week_start_date),
        "weekly": _weekly_completion_headline(),
        "top_product": _top_product_conversion(),
        "delegates": {
            "active": active,
            "total": len(users),
            "inactive": len(users) - active,
        },
        "performance": _delegate_performance(week_start_date),
        "client_classes": list(CLIENT_CLASSES),
    }


@frappe.whitelist()
def search_delegates(txt=""):
    """Field delegates only, for the manager's client-assignment
    picker — a Delegate Manager is excluded even though the role
    bundle also gives them the Delegate role (see _is_plain_delegate);
    they're not who a client should ever be assigned to."""
    _require_manager()

    delegate_users = frappe.get_all(
        "Has Role", filters={"role": "Delegate", "parenttype": "User"}, pluck="parent"
    )
    delegate_users = [d for d in delegate_users if _is_plain_delegate(d)]
    visible = _visible_delegates()
    if visible is not None:
        delegate_users = [d for d in delegate_users if d in set(visible)]
    if not delegate_users:
        return []

    filters = {"name": ["in", delegate_users]}
    if txt:
        filters["full_name"] = ["like", f"%{txt}%"]

    return frappe.get_all("User", filters=filters, fields=["name", "full_name"], limit_page_length=10)


@frappe.whitelist()
def assign_visit(delegate, customer, scheduled_date, scheduled_time=None, contact_person=None):
    """Manager creates a real (Scheduled) Visit Assignment — this is
    the primary manager action the whole page exists for."""
    _require_manager()

    if not _is_plain_delegate(delegate):
        frappe.throw(_("Selected user is not a field delegate — a Delegate Manager can't be assigned a visit."))
    _assert_delegate_visible(delegate)

    if getdate(scheduled_date) < getdate(nowdate()):
        frappe.throw(_("Cannot assign a visit for a date in the past."))

    assignment = frappe.new_doc("Visit Assignment")
    assignment.delegate = delegate
    assignment.customer = customer
    assignment.contact_person = contact_person
    assignment.scheduled_date = scheduled_date
    assignment.scheduled_time = scheduled_time
    assignment.status = "Pending"
    assignment.visit_type = "Scheduled"
    assignment.insert()
    frappe.db.commit()

    return {"ok": True, "assignment": assignment.name}


@frappe.whitelist()
def reassign_visit(assignment, new_delegate):
    """Manager reassigns an existing assignment to a different
    delegate — resets it to Pending since the new delegate hasn't
    acted on it yet."""
    _require_manager()

    if "Delegate" not in frappe.get_roles(new_delegate):
        frappe.throw(_("Selected user does not have the Delegate role"))
    _assert_delegate_visible(new_delegate)

    doc = frappe.get_doc("Visit Assignment", assignment)
    _assert_delegate_visible(doc.delegate)
    doc.delegate = new_delegate
    doc.status = "Pending"
    doc.save()
    frappe.db.commit()

    return {"ok": True}


# ============================================================
# Table views (Quick Links) — Client List, Visit History, Delegates
# ============================================================


@frappe.whitelist()
def list_customers(txt=""):
    """Full filterable client list for the manager's 'View Client
    List' embedded table."""
    _require_manager()

    filters = {"is_medvisitpro_enabled": 1}
    if txt:
        filters["customer_name"] = ["like", f"%{txt}%"]

    customers = frappe.get_all(
        "Customer",
        filters=filters,
        fields=[
            "name", "customer_name", "customer_type", "customer_category",
            "customer_class", "expected_visits_per_month",
        ],
        order_by="customer_name asc",
        limit_page_length=200,
    )
    for c in customers:
        c["address"] = _customer_address(c.name)
        c["customer_category"] = c.customer_category or "Uncategorized"
        c["customer_class"] = c.customer_class or "Unclassed"
    return customers


@frappe.whitelist()
def list_client_contacts(txt=""):
    """Every enabled client's roster, flattened to one row per Point of
    Contact — the Clients table shows this instead of one row per
    organization, since a Point of Contact (not the organization
    itself) is who a delegate actually visits. Same shape as
    _delegate_portfolio_rows/_roster_export_rows, just unscoped to any
    one delegate. Search matches either the Point of Contact's name or
    their organization's."""
    _require_manager()

    customers = frappe.get_all(
        "Customer",
        filters={"is_medvisitpro_enabled": 1},
        fields=[
            "name", "customer_name", "customer_category", "customer_class",
            "expected_visits_per_month", "province", "district",
        ],
        order_by="customer_name asc",
        limit_page_length=0,
    )

    txt_lower = (txt or "").strip().lower()
    # Cached across rows — the same handful of managers/delegates tend
    # to be the ones editing records, so this avoids re-querying User
    # for the same modified_by over and over.
    full_names = {}

    def _full_name(user):
        if not user:
            return ""
        if user not in full_names:
            full_names[user] = frappe.db.get_value("User", user, "full_name") or user
        return full_names[user]

    rows = []
    for c in customers:
        for ct in get_customer_contacts(c.name):
            if txt_lower and txt_lower not in ct.display_name.lower() and txt_lower not in (c.customer_name or "").lower():
                continue
            rows.append({
                "contact": ct.name,
                "point_of_contact": ct.display_name,
                "speciality": ct.designation or "",
                "phone": ct.phone or "",
                "email": ct.email or "",
                "customer": c.name,
                "organization": c.customer_name,
                "customer_category": c.customer_category or "Uncategorized",
                "customer_class": c.customer_class or "Unclassed",
                "expected_visits_per_month": c.expected_visits_per_month,
                "province": c.province or "",
                "district": c.district or "",
                "last_updated_by": _full_name(ct.modified_by),
            })
    return rows


@frappe.whitelist()
def get_customer_details(customer):
    """Read-only detail for a single client, powering the manager's
    client detail modal on the Client List table. Bundles the contact
    phone, address, and a short visit summary (total logged visits and
    the most recent check-in) so the manager gets the full picture in
    one place."""
    _require_manager()

    c = frappe.db.get_value(
        "Customer",
        customer,
        [
            "name", "customer_name", "customer_type", "customer_category",
            "customer_class", "expected_visits_per_month", "is_medvisitpro_enabled",
            "assigned_delegate", "province", "district", "medvisitpro_client_id", "creation",
        ],
        as_dict=True,
    )
    if not c:
        frappe.throw(_("Client not found"))

    address_line1, city = "", ""
    address_name = frappe.db.get_value(
        "Dynamic Link",
        {"link_doctype": "Customer", "link_name": customer, "parenttype": "Address"},
        "parent",
    )
    if address_name:
        addr = frappe.db.get_value("Address", address_name, ["address_line1", "city"], as_dict=True)
        if addr:
            address_line1 = addr.address_line1 or ""
            city = addr.city or ""

    last_visit = frappe.db.get_value(
        "Visit", {"customer": customer}, "checkin_time", order_by="checkin_time desc"
    )

    return {
        "customer": c.name,
        "client_id": c.medvisitpro_client_id,
        "creation": str(c.creation) if c.creation else None,
        "customer_name": c.customer_name,
        "customer_type": c.customer_type or "—",
        "customer_category": c.customer_category or "Uncategorized",
        # Both of these were fetched above but left out of the response,
        # so the modal always fell through to its "Unclassed" / "—"
        # defaults while the Client List table — reading the same two
        # fields via list_customers — showed the real values.
        "customer_class": c.customer_class,
        "expected_visits_per_month": c.expected_visits_per_month,
        "enabled": bool(c.is_medvisitpro_enabled),
        "phone": _customer_phone(customer),
        "email": _customer_email(customer),
        "address_line1": address_line1,
        "city": city,
        "province": c.province,
        "district": c.district,
        "assigned_delegate": c.assigned_delegate,
        "assigned_delegate_name": (
            frappe.db.get_value("User", c.assigned_delegate, "full_name") if c.assigned_delegate else None
        ),
        "contacts": get_customer_contacts(customer),
        "total_visits": frappe.db.count("Visit", {"customer": customer}),
        "last_visit": str(last_visit) if last_visit else None,
    }


@frappe.whitelist()
def list_visits(txt="", delegate="", status="", date_from="", date_to="", include_archived=False):
    """Full Visit History — every Visit Assignment regardless of
    status (Pending / Completed / Missed), not just completed
    check-ins. Filters by delegate, status, and scheduled_date range
    at the DB level; free-text search (matches client or delegate
    name) is applied after, since it spans two joined names.

    Queries Visit Assignment rather than Visit specifically because
    Visit only has a record once a visit is actually completed —
    it has no concept of Pending/Missed, so a Status filter wouldn't
    be possible against it.

    Archived rows (see archive_visit_assignment) are excluded unless
    include_archived is set — the "Show Archived" toggle on the
    History table."""
    _require_manager()

    filters = _scope_to_delegates({})
    if filters is None:
        return []
    if delegate:
        _assert_delegate_visible(delegate)
        filters["delegate"] = delegate
    if status:
        filters["status"] = status
    if date_from and date_to:
        filters["scheduled_date"] = ["between", [date_from, date_to]]
    elif date_from:
        filters["scheduled_date"] = [">=", date_from]
    elif date_to:
        filters["scheduled_date"] = ["<=", date_to]
    include_archived = include_archived in (True, "true", "1", 1)
    if not include_archived:
        filters["archived"] = 0

    assignments = frappe.get_all(
        "Visit Assignment",
        filters=filters,
        fields=[
            "name", "customer", "delegate", "scheduled_date", "status", "visit_type", "visit",
            "archived", "archived_on", "archived_by",
        ],
        order_by="scheduled_date desc",
        limit_page_length=300,
    )

    for a in assignments:
        a["customer_name"] = frappe.db.get_value("Customer", a.customer, "customer_name") or a.customer
        a["delegate_name"] = frappe.db.get_value("User", a.delegate, "full_name") or a.delegate
        a["scheduled_date"] = str(a.scheduled_date) if a.scheduled_date else None

        # Only Completed assignments have a linked Visit with
        # coordinates — everything else simply won't have a map link.
        if a.visit:
            coords = frappe.db.get_value(
                "Visit", a.visit,
                ["checkin_latitude", "checkin_longitude", "checkin_address",
                 "checkin_accuracy", "checkin_location_source"],
                as_dict=True
            )
            if coords:
                a["checkin_latitude"] = coords.checkin_latitude
                a["checkin_longitude"] = coords.checkin_longitude
                a["checkin_address"] = coords.checkin_address or ""
                a["checkin_accuracy"] = coords.checkin_accuracy
                a["checkin_location_source"] = coords.checkin_location_source

    if txt:
        txt_lower = txt.lower()
        assignments = [
            a for a in assignments
            if txt_lower in (a["customer_name"] or "").lower()
            or txt_lower in (a["delegate_name"] or "").lower()
        ]

    return assignments


@frappe.whitelist()
def archive_visit_assignment(assignment):
    """'Deletes' a row off Visit History — really a soft delete. The
    Visit Assignment (and the Visit it may be linked to, with all its
    check-in/outcome data) stays on file; it's just excluded from
    list_visits by default from now on, and can be brought back with
    restore_visit_assignment. Compliance-sensitive history is never
    actually destroyed by a Delegate Manager's own action."""
    _require_manager()

    if not frappe.db.exists("Visit Assignment", assignment):
        return {"ok": False, "error": _("This visit no longer exists.")}

    delegate = frappe.db.get_value("Visit Assignment", assignment, "delegate")
    _assert_delegate_visible(delegate)

    frappe.db.set_value("Visit Assignment", assignment, {
        "archived": 1,
        "archived_on": now_datetime(),
        "archived_by": frappe.session.user,
    })
    frappe.db.commit()
    return {"ok": True}


@frappe.whitelist()
def restore_visit_assignment(assignment):
    """Undoes archive_visit_assignment. Kept to a smaller set of
    people than archiving — see _require_admin_or_regional_manager."""
    _require_admin_or_regional_manager()

    if not frappe.db.exists("Visit Assignment", assignment):
        return {"ok": False, "error": _("This visit no longer exists.")}

    delegate = frappe.db.get_value("Visit Assignment", assignment, "delegate")
    _assert_delegate_visible(delegate)

    frappe.db.set_value("Visit Assignment", assignment, {
        "archived": 0,
        "archived_on": None,
        "archived_by": None,
    })
    frappe.db.commit()
    return {"ok": True}


@frappe.whitelist()
def get_visit_details(assignment):
    """Full detail for a single Visit Assignment, powering the
    manager's read-only visit detail modal on the Visit History table.

    Queries Visit Assignment (not Visit) because the history rows are
    assignments and may be Pending/Missed — those have no linked Visit
    record yet, so the modal shows the schedule info alone. Once the
    assignment is Completed, the linked Visit's notes, outcome,
    products, and check-in data are included."""
    _require_manager()

    va = frappe.db.get_value(
        "Visit Assignment",
        assignment,
        ["name", "customer", "contact_person", "delegate", "scheduled_date",
         "scheduled_time", "status", "visit_type", "visit"],
        as_dict=True,
    )
    if not va:
        frappe.throw(_("Visit not found"))
    _assert_delegate_visible(va.delegate)

    data = {
        "assignment": va.name,
        "customer": va.customer,
        "customer_name": frappe.db.get_value("Customer", va.customer, "customer_name") or va.customer,
        "contact_person_name": _contact_display_name(va.contact_person),
        "delegate_name": frappe.db.get_value("User", va.delegate, "full_name") or va.delegate,
        "scheduled_date": str(va.scheduled_date) if va.scheduled_date else None,
        "scheduled_time": str(va.scheduled_time) if va.scheduled_time else None,
        "status": va.status,
        "visit_type": va.visit_type,
        "visit": None,
    }

    if va.visit:
        v = frappe.db.get_value(
            "Visit",
            va.visit,
            ["name", "discussion_notes", "outcome", "checkin_time",
             "checkin_latitude", "checkin_longitude", "checkin_accuracy",
             "checkin_address", "checkin_location_source", "sales_order"],
            as_dict=True,
        )
        if v:
            products = frappe.get_all(
                "Visit Product",
                filters={"parent": va.visit, "parenttype": "Visit"},
                fields=["item", "remarks"],
                order_by="idx asc",
            )
            for p in products:
                p["item_name"] = frappe.db.get_value("Item", p.item, "item_name") or p.item
            v["products"] = products
            v["checkin_time"] = str(v.checkin_time) if v.checkin_time else None
            v["order"] = _visit_order_summary(v.sales_order)
            data["visit"] = v

    return data


def _visit_order_summary(sales_order):
    """Compact view of the Sales Order linked to a visit, for the
    manager's visit detail modal: its confirmation state, total, and
    line items. Returns None when the visit has no order."""
    if not sales_order or not frappe.db.exists("Sales Order", sales_order):
        return None

    so = frappe.db.get_value(
        "Sales Order", sales_order,
        ["name", "docstatus", "status", "grand_total", "currency"],
        as_dict=True,
    )
    items = frappe.get_all(
        "Sales Order Item",
        filters={"parent": sales_order},
        fields=["item_code", "item_name", "qty", "rate", "amount"],
        order_by="idx asc",
    )
    return {
        "name": so.name,
        # docstatus 0 = Draft (awaiting manager confirmation), 1 =
        # Submitted (confirmed), 2 = Cancelled.
        "is_draft": so.docstatus == 0,
        "is_confirmed": so.docstatus == 1,
        "status": so.status,
        "grand_total": so.grand_total,
        "currency": so.currency,
        "items": items,
    }


@frappe.whitelist()
def confirm_sales_order(sales_order):
    """Manager confirms a delegate-placed draft order by submitting the
    Sales Order (docstatus 0 -> 1). Only draft orders can be confirmed;
    anything else is returned as a no-op error message."""
    _require_manager()

    if not frappe.db.exists("Sales Order", sales_order):
        return {"ok": False, "error": _("This order no longer exists.")}

    so = frappe.get_doc("Sales Order", sales_order)
    if so.docstatus != 0:
        return {"ok": False, "error": _("This order has already been confirmed or cancelled.")}

    # Role-gated above; bypass native Sales Order submit permission the
    # same way create_* methods bypass create permission — the Delegate
    # Manager role isn't granted raw ERPNext selling permissions.
    so.flags.ignore_permissions = True
    so.submit()
    frappe.db.commit()
    return {"ok": True, "status": so.status, "grand_total": so.grand_total}


@frappe.whitelist()
def _specialist_counts_by_delegate(delegate_names):
    """How many named points of contact each of these delegates is
    responsible for — the same "specialist" _delegate_portfolio_rows
    counts, computed in bulk (2 queries total, not one per delegate)
    since this powers a column across the whole Delegates list."""
    if not delegate_names:
        return {}
    customers = frappe.get_all(
        "Customer",
        filters={"is_medvisitpro_enabled": 1, "assigned_delegate": ["in", delegate_names]},
        fields=["name", "assigned_delegate"],
    )
    if not customers:
        return {}
    customer_to_delegate = {c.name: c.assigned_delegate for c in customers}
    contact_customers = frappe.get_all(
        "Dynamic Link",
        filters={
            "link_doctype": "Customer", "link_name": ["in", list(customer_to_delegate)],
            "parenttype": "Contact",
        },
        pluck="link_name",
    )
    counts = {}
    for customer_name in contact_customers:
        delegate = customer_to_delegate.get(customer_name)
        if delegate:
            counts[delegate] = counts.get(delegate, 0) + 1
    return counts


@frappe.whitelist()
def list_delegates():
    """All Delegate-role users, for the manager's 'View Delegates'
    embedded table and the visit-history delegate filter dropdown.

    Includes each person's role, phone, territory, and how many named
    points of contact ("specialists") they're responsible for. A
    manager's own portfolio is normally empty — territory is cleared
    for managers (see update_delegate) and clients aren't assigned to
    a manager directly — so a manager's count is the roll-up of the
    delegates who report to them (medvisitpro_manager) instead. That
    roll-up is what this app treats as a manager's team KPI.
    """
    _require_manager()

    delegate_users = frappe.get_all(
        "Has Role", filters={"role": "Delegate", "parenttype": "User"}, pluck="parent"
    )
    visible = _visible_delegates()
    if visible is not None:
        delegate_users = [d for d in delegate_users if d in set(visible)]
    if not delegate_users:
        return []

    rows = frappe.get_all(
        "User",
        filters={"name": ["in", delegate_users]},
        fields=[
            "name", "full_name", "email", "mobile_no", "enabled",
            "primary_territory", "secondary_territory", "medvisitpro_manager",
        ],
        order_by="full_name asc",
    )

    role_rows = frappe.get_all(
        "Has Role", filters={"parent": ["in", delegate_users], "parenttype": "User"},
        fields=["parent", "role"],
    )
    roles_by_user = {}
    for rr in role_rows:
        roles_by_user.setdefault(rr.parent, set()).add(rr.role)

    # Every delegate's brands in one query rather than one per row —
    # the same bulk shape delegates_visible_to uses.
    brands_by_user = {}
    for br in frappe.get_all(
        "Delegate Brand",
        filters={"parent": ["in", delegate_users], "parenttype": "User"},
        fields=["parent", "brand"],
    ):
        if br.brand:
            brands_by_user.setdefault(br.parent, []).append(br.brand)

    own_counts = _specialist_counts_by_delegate(delegate_users)

    managed_by = {}
    for r in rows:
        if r.medvisitpro_manager:
            managed_by.setdefault(r.medvisitpro_manager, []).append(r.name)

    # Resolve each delegate's manager to a display name, cached so a team
    # sharing one manager costs a single lookup, not one row.
    manager_names = {}

    def _manager_name(user):
        if not user:
            return ""
        if user not in manager_names:
            manager_names[user] = frappe.db.get_value("User", user, "full_name") or user
        return manager_names[user]

    for r in rows:
        roles = roles_by_user.get(r.name, set())
        if "Regional Manager" in roles:
            r["role"] = "Regional Manager"
        elif "Delegate Manager" in roles:
            r["role"] = "Delegate Manager"
        else:
            r["role"] = "Delegate"
        r["territory"] = ", ".join(filter(None, [r.primary_territory, r.secondary_territory]))
        r["manager"] = r.medvisitpro_manager
        r["manager_name"] = _manager_name(r.medvisitpro_manager)
        r["enabled"] = bool(r.enabled)
        # No brands = every brand (an unscoped manager); mirrors
        # manager_sees_all_brands, so the UI can say "All brands".
        r["brands"] = sorted(brands_by_user.get(r.name, []))
        if r["role"] == "Delegate":
            r["specialist_count"] = own_counts.get(r.name, 0)
        else:
            r["specialist_count"] = sum(own_counts.get(child, 0) for child in managed_by.get(r.name, []))

    return rows


# ============================================================
# In-app creation: Client and Delegate onboarding
# ============================================================
# Both use ignore_permissions=True deliberately — Delegate Manager
# intentionally lacks raw Customer/User create permission (to
# prevent bulk/arbitrary creation via Desk), so these validated,
# role-gated methods are the one sanctioned path for it. Same
# pattern as the Weekly Visit Plan methods further down.


# The subscriber part of a number, after any country or trunk prefix.
# ASSUMPTION: 9 digits, which is Rwanda (+250 7xx xxx xxx, written
# locally as 07xx xxx xxx). This is what makes "0788123456" and
# "+250788123456" recognisable as the same client rather than two.
# A deployment in a country with a different subscriber length needs
# this changed.
SUBSCRIBER_DIGITS = 9


def _phone_match_key(phone):
    """The trailing subscriber digits, used to compare two numbers
    written in different formats. Returns "" for anything with no
    digits at all."""
    digits = "".join(ch for ch in str(phone or "") if ch.isdigit())
    if not digits:
        return ""
    return digits[-SUBSCRIBER_DIGITS:] if len(digits) > SUBSCRIBER_DIGITS else digits


def _customer_id_with_phone(phone):
    """The record id of the client whose linked Contact uses this phone,
    or None.

    Comparison is on the subscriber digits, not the literal string: the
    same client entered once as 0788123456 and once as +250788123456
    must be caught as the same client, or the second one silently
    becomes a duplicate."""
    key = _phone_match_key(phone)
    if not key:
        return None

    # Trailing-wildcard match can't use an index, but the contact
    # tables here are small (one or two rows per client) and this runs
    # once per created client, not per lookup in a hot path.
    like = f"%{key}"
    contact_names = set(
        frappe.get_all("Contact Phone", filters={"phone": ["like", like]}, pluck="parent")
    )
    contact_names.update(
        frappe.get_all(
            "Contact",
            or_filters={"mobile_no": ["like", like], "phone": ["like", like]},
            pluck="name",
        )
    )
    for cname in contact_names:
        customer = frappe.db.get_value(
            "Dynamic Link",
            {"parent": cname, "parenttype": "Contact", "link_doctype": "Customer"},
            "link_name",
        )
        if customer:
            return customer
    return None


def _customer_with_phone(phone):
    """Display name of the client using this phone, or None. Phone is
    the uniqueness key for a client, so this backs the duplicate check."""
    customer = _customer_id_with_phone(phone)
    if not customer:
        return None
    return frappe.db.get_value("Customer", customer, "customer_name") or customer


def _customer_id_with_email(email):
    """The record id of the client whose Contact uses this email, or
    None. Unlike phone, comparison is a plain case-insensitive match —
    there's no formatting variance to normalise away."""
    email = (email or "").strip().lower()
    if not email:
        return None

    contact_names = frappe.get_all(
        "Contact Email", filters={"email_id": email}, pluck="parent"
    )
    for cname in contact_names:
        customer = frappe.db.get_value(
            "Dynamic Link",
            {"parent": cname, "parenttype": "Contact", "link_doctype": "Customer"},
            "link_name",
        )
        if customer:
            return customer
    return None


def _customer_with_email(email):
    """Display name of the client using this email, or None."""
    customer = _customer_id_with_email(email)
    if not customer:
        return None
    return frappe.db.get_value("Customer", customer, "customer_name") or customer


# A generous but real check: something@something.tld. Client emails are
# typed by hand off a business card or a WhatsApp message, so this
# exists to catch "info@clinic" or "info@clinic,com" — obvious slips —
# without being strict enough to reject a real address the way a
# full RFC 5322 pattern would.
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")


def _validate_email(value):
    """Returns (cleaned_email, error_message). error_message is None
    when the address is usable. Cleaning is just a trim + lowercase —
    unlike phone there's no punctuation people habitually add."""
    cleaned = (value or "").strip().lower()
    if not cleaned:
        return cleaned, None  # email is optional; blank is not an error
    if not _EMAIL_RE.match(cleaned):
        return cleaned, _("'{0}' doesn't look like a valid email address.").format(value)
    return cleaned, None


def _set_customer_email(customer, email):
    """Point this client's Contact at `email`, creating the Contact if
    they have none. Mirrors _set_customer_phone."""
    contact_name = _customer_contact_name(customer)
    if contact_name:
        contact = frappe.get_doc("Contact", contact_name)
        contact.set("email_ids", [])
    else:
        contact = frappe.new_doc("Contact")
        contact.first_name = frappe.db.get_value("Customer", customer, "customer_name") or customer
        contact.append("links", {"link_doctype": "Customer", "link_name": customer})

    contact.append("email_ids", {"email_id": email, "is_primary": 1})
    contact.save(ignore_permissions=True)


def _set_customer_phone(customer, phone):
    """Point this client's Contact at `phone`, creating the Contact if
    they somehow have none (an import from before contacts were made, or
    a client created straight in Desk).

    Phone numbers live in the phone_nos child table; writing the
    read-only `mobile_no` field directly does not persist, because
    validate rebuilds it from phone_nos."""
    contact_name = frappe.db.get_value(
        "Dynamic Link",
        {"link_doctype": "Customer", "link_name": customer, "parenttype": "Contact"},
        "parent",
    )
    if contact_name:
        contact = frappe.get_doc("Contact", contact_name)
        contact.set("phone_nos", [])
    else:
        contact = frappe.new_doc("Contact")
        contact.first_name = frappe.db.get_value("Customer", customer, "customer_name") or customer
        contact.append("links", {"link_doctype": "Customer", "link_name": customer})

    contact.append("phone_nos", {"phone": phone, "is_primary_mobile_no": 1})
    contact.save(ignore_permissions=True)


def _set_customer_address(customer, address_line1, city):
    """Update the client's address, creating one if they have none.
    Either field may be blank, meaning "leave that part alone"."""
    address_name = frappe.db.get_value(
        "Dynamic Link",
        {"link_doctype": "Customer", "link_name": customer, "parenttype": "Address"},
        "parent",
    )
    if address_name:
        address = frappe.get_doc("Address", address_name)
    else:
        if not address_line1:
            return
        address = frappe.new_doc("Address")
        address.address_title = (
            frappe.db.get_value("Customer", customer, "customer_name") or customer
        )
        address.address_type = "Billing"
        address.append("links", {"link_doctype": "Customer", "link_name": customer})

    if address_line1:
        address.address_line1 = address_line1
    if city:
        address.city = city
    address.save(ignore_permissions=True)


@frappe.whitelist()
def create_customer(customer_name, customer_type="Company", customer_category=None,
                     customer_class=None, phone=None, email=None,
                     address_line1=None, city=None, province=None, district=None):
    """Lets a Delegate Manager add a new client directly from this
    app, without needing Frappe Desk access. Auto-flags the new
    Customer as MedvisitPro-enabled, and optionally attaches a
    Contact (phone, email) and Address using the same Dynamic Link
    pattern _customer_phone/_customer_address already expect.

    Phone is the uniqueness key: it is required and must not already
    belong to another client. Email is optional but, when given, must
    also be unique — the same rule the spreadsheet import enforces, so
    a client can't end up with a repeated phone or email regardless of
    which door they came in through."""
    _require_manager()

    # Validation failures are returned as {"ok": False, ...} with a 200
    # rather than raised via frappe.throw: the dev server (Werkzeug on
    # Python 3.14) mangles error responses, so a thrown message never
    # reaches the browser. Returning data keeps the message intact in
    # both dev and production.
    if not customer_name:
        return {"ok": False, "error": _("Client name is required.")}

    # Everything this form asks for is required except email — matches
    # the Add Client modal, which validates the same fields client-side
    # before this is ever called. Checked here too since this endpoint
    # is reachable directly, not just from that one form.
    for value, label in (
        (customer_category, _("Category")),
        (customer_class, _("Client Class")),
        (province, _("Province")),
        (district, _("District")),
        (address_line1, _("Street address")),
        (city, _("City")),
    ):
        if not (value or "").strip():
            return {"ok": False, "error": _("{0} is required.").format(label)}

    phone = (phone or "").strip()
    if not phone:
        return {"ok": False, "error": _("Phone number is required — it uniquely identifies a client.")}

    phone, phone_error = _validate_phone(phone)
    if phone_error:
        return {"ok": False, "error": phone_error}

    existing = _customer_with_phone(phone)
    if existing:
        return {"ok": False, "error": _("A client with this phone number already exists: {0}.").format(existing)}

    email, email_error = _validate_email(email)
    if email_error:
        return {"ok": False, "error": email_error}
    if email:
        existing_email = _customer_with_email(email)
        if existing_email:
            return {"ok": False, "error": _("A client with this email already exists: {0}.").format(existing_email)}

    province, district, geo_error = _validate_province_district(province or None, district or None)
    if geo_error:
        return {"ok": False, "error": geo_error}

    customer = frappe.new_doc("Customer")
    customer.customer_name = customer_name
    customer.customer_type = customer_type
    customer.customer_category = customer_category
    # expected_visits_per_month is derived from this on validate —
    # see set_expected_visits_from_class in customer_hooks.py.
    customer.customer_class = customer_class
    customer.province = province or None
    customer.district = district or None
    customer.is_medvisitpro_enabled = 1
    customer.insert(ignore_permissions=True)

    # Phone numbers live in the phone_nos child table; setting the
    # read-only `mobile_no` field directly does NOT persist (validate
    # rebuilds it from phone_nos). Appending here also syncs mobile_no.
    # Email works the same way, via email_ids.
    contact = frappe.new_doc("Contact")
    contact.first_name = customer_name
    contact.append("phone_nos", {"phone": phone, "is_primary_mobile_no": 1})
    if email:
        contact.append("email_ids", {"email_id": email, "is_primary": 1})
    contact.append("links", {"link_doctype": "Customer", "link_name": customer.name})
    contact.insert(ignore_permissions=True)

    if address_line1:
        address = frappe.new_doc("Address")
        address.address_title = customer_name
        address.address_type = "Billing"
        address.address_line1 = address_line1
        address.city = city or ""
        address.append("links", {"link_doctype": "Customer", "link_name": customer.name})
        address.insert(ignore_permissions=True)

    frappe.db.commit()
    return {"ok": True, "customer": customer.name}


@frappe.whitelist()
def save_client_record(customer_name, point_of_contact, customer_category=None, customer_class=None,
                        speciality=None, phone=None, email=None, province=None, district=None, customer=None):
    """The Add Client modal's endpoint — one Organization and one
    Point of Contact together, the same shape as a roster row (see
    ROSTER_IMPORT_COLUMNS / import_roster). `customer` (a Customer
    record name), when given, means the manager picked an existing
    organization from the picker: this updates that Customer's
    org-level fields and adds/updates a Point of Contact under it by
    name (see _find_or_update_roster_contact), rather than creating a
    duplicate organization. Without it, both are created fresh, same
    as a new row in the Roster import.

    Takes the raw record name rather than medvisitpro_client_id: this
    is a same-session UI picker reading a name straight out of its own
    search results, not a spreadsheet re-uploaded after the fact, so
    there's no rename-drift for the stabler id to guard against."""
    _require_manager()

    customer_name = (customer_name or "").strip()
    point_of_contact = (point_of_contact or "").strip()

    for value, label in (
        (customer_name, _("Organization")),
        (point_of_contact, _("Point of Contact")),
        (customer_category, _("Org-Type")),
        (customer_class, _("Category")),
        (province, _("Province")),
        (district, _("District")),
        (phone, _("Phone")),
    ):
        if not (value or "").strip():
            return {"ok": False, "error": _("{0} is required.").format(label)}

    matched_category = _match_choice(customer_category, VALID_CATEGORIES)
    if not matched_category:
        return {"ok": False, "error": _("Org-Type must be one of: {0}.").format(", ".join(VALID_CATEGORIES))}
    matched_class = _match_choice(customer_class, VALID_CLASSES)
    if not matched_class:
        return {"ok": False, "error": _("Category must be one of: {0}.").format(", ".join(VALID_CLASSES))}

    province, district, geo_error = _validate_province_district(province, district)
    if geo_error:
        return {"ok": False, "error": geo_error}

    if customer and not frappe.db.exists("Customer", customer):
        return {"ok": False, "error": _("This client no longer exists.")}

    cleaned_phone, phone_error = _validate_phone(_normalise_roster_phone(phone))
    if phone_error:
        return {"ok": False, "error": phone_error}

    email, email_error = _validate_email(email)
    if email_error:
        return {"ok": False, "error": email_error}

    # A phone match is only a conflict if it belongs to someone other
    # than the exact contact this row is about to update — checked
    # before any write, same as import_roster's per-row validation.
    existing_here = None
    if customer:
        existing_here = next(
            (c for c in get_customer_contacts(customer) if c.display_name.strip().lower() == point_of_contact.lower()),
            None,
        )
    phone_owner = _contact_id_with_phone(cleaned_phone)
    already_theirs = existing_here and phone_owner == existing_here.name
    if phone_owner and not already_theirs:
        return {"ok": False, "error": _("That phone already belongs to {0}.").format(
            _contact_phone_owner_name(phone_owner)
        )}

    if customer:
        # expected_visits_per_month is normally derived on doc.save()
        # by set_expected_visits_from_class (customer_hooks.py), but
        # this is a raw DB write — that hook never fires here, so it's
        # computed directly instead, from the same mapping.
        frappe.db.set_value("Customer", customer, {
            "customer_name": customer_name,
            "customer_category": matched_category,
            "customer_class": matched_class,
            "expected_visits_per_month": EXPECTED_VISITS_BY_CLASS.get(matched_class, 0),
            "province": province,
            "district": district,
        })
    else:
        doc = frappe.new_doc("Customer")
        doc.customer_name = customer_name
        doc.customer_type = "Company"
        doc.customer_category = matched_category
        doc.customer_class = matched_class
        doc.province = province
        doc.district = district
        doc.is_medvisitpro_enabled = 1
        doc.insert(ignore_permissions=True)
        customer = doc.name

    _created, error = _find_or_update_roster_contact(customer, point_of_contact, speciality, cleaned_phone, email)
    if error:
        return {"ok": False, "error": error}

    frappe.db.commit()
    client_id = frappe.db.get_value("Customer", customer, "medvisitpro_client_id")
    return {"ok": True, "customer": customer, "client_id": client_id}


def _generate_temp_password(length=10):
    import secrets
    import string
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _outgoing_email_configured():
    """True if this site can actually send mail — either via bench
    mail_* config or a default-outgoing Email Account. Gates whether we
    rely on Frappe's welcome email (user sets their own password via a
    link) or fall back to handing over a temporary password in the UI."""
    if frappe.conf.get("mail_server") or frappe.conf.get("mail_login"):
        return True
    return bool(
        frappe.db.exists("Email Account", {"enable_outgoing": 1, "default_outgoing": 1})
    )


@frappe.whitelist()
def create_delegate(full_name, email, mobile_no=None, also_manager=False, brands=None):
    """Lets a Delegate Manager onboard a new delegate directly from
    this app — or, for a Regional Manager only, a new Delegate
    Manager. Returns a temp password to hand to the new user, rather
    than relying on outbound email working (many local/dev Frappe
    setups don't have SMTP configured).

    A plain delegate's brands aren't chosen here — they're copied from
    the creating manager's own brands and stay locked to them (see
    update_delegate / _sync_managed_delegates_brands), which is what
    keeps a manager's whole team scoped to the same brand(s). `brands`
    is only read when also_manager is set: a Regional Manager picking
    which brand(s) a brand-new Delegate Manager will own."""
    _require_manager()

    also_manager = also_manager in (True, "true", "1", 1)
    if also_manager:
        _require_regional_manager()

    # Validation failures return {"ok": False, ...} (200) rather than
    # frappe.throw — see the note in create_customer for why.
    if not full_name or not (email or "").strip():
        return {"ok": False, "error": _("Full name and email are required.")}

    # Email is the uniqueness key for a delegate. Normalise it the way
    # Frappe stores User emails (trimmed + lowercased) so the check is
    # case-insensitive and whitespace-proof.
    email = email.strip().lower()
    if frappe.db.exists("User", {"email": email}):
        existing_name = frappe.db.get_value("User", {"email": email}, "full_name") or email
        return {"ok": False, "error": _("A delegate with this email already exists: {0}.").format(existing_name)}

    name_parts = full_name.strip().split(" ", 1)
    first_name = name_parts[0]
    last_name = name_parts[1] if len(name_parts) > 1 else ""

    # Preferred path: if the site can send mail, let Frappe send its
    # welcome email, which carries a secure link for the new user to set
    # their OWN password — nothing secret travels in plain text.
    # Fallback (no SMTP configured, e.g. local/dev): create the account
    # with a temp password and surface it in the UI so the manager can
    # hand it over.
    emailed = _outgoing_email_configured()
    temp_password = None if emailed else _generate_temp_password()

    user = frappe.new_doc("User")
    user.email = email
    user.first_name = first_name
    user.last_name = last_name
    user.mobile_no = mobile_no
    user.send_welcome_email = 1 if emailed else 0
    if temp_password:
        user.new_password = temp_password
    user.append("roles", {"role": "Delegate"})
    if also_manager:
        user.append("roles", {"role": "Delegate Manager"})
        brand_list = json.loads(brands) if isinstance(brands, str) else (brands or [])
        for b in brand_list:
            if b:
                user.append("medvisitpro_brands", {"brand": b})
    else:
        user.medvisitpro_manager = frappe.session.user
        for b in user_brands(frappe.session.user):
            user.append("medvisitpro_brands", {"brand": b})
    user.insert(ignore_permissions=True)
    frappe.db.commit()

    return {
        "ok": True,
        "user": user.name,
        "emailed": emailed,
        "temp_password": temp_password,
    }


@frappe.whitelist()
def get_delegate(name):
    """Current values for a single delegate, to prefill the manager's
    Edit Delegate modal."""
    _require_manager()

    if not frappe.db.exists("User", name) or "Delegate" not in frappe.get_roles(name):
        frappe.throw(_("Delegate not found"))

    u = frappe.db.get_value(
        "User", name,
        ["name", "full_name", "email", "mobile_no", "enabled",
         "primary_territory", "secondary_territory", "medvisitpro_manager"],
        as_dict=True,
    )
    return {
        "name": u.name,
        "full_name": u.full_name or "",
        "email": u.email,
        "mobile_no": u.mobile_no or "",
        "enabled": u.enabled,
        "is_manager": "Delegate Manager" in frappe.get_roles(name),
        "primary_territory": u.primary_territory,
        "secondary_territory": u.secondary_territory,
        "brands": user_brands(name),
        # Who this delegate reports to (medvisitpro_manager). Powers the
        # Regional-Manager-only reassignment picker — see
        # reassign_delegate / list_delegate_managers.
        "manager": u.medvisitpro_manager,
        "manager_name": (
            frappe.db.get_value("User", u.medvisitpro_manager, "full_name") or u.medvisitpro_manager
            if u.medvisitpro_manager else None
        ),
        "assigned_client_count": frappe.db.count("Customer", {"assigned_delegate": name}),
    }


def _sync_managed_delegates_brands(manager):
    """Keeps every delegate's brands mirroring their manager's,
    whenever the manager's own brands are edited (below). This is what
    keeps "all delegates under this manager carry the same brand" true
    on an ongoing basis, not just at the moment a delegate is created."""
    brands = user_brands(manager)
    managed = frappe.get_all("User", filters={"medvisitpro_manager": manager}, pluck="name")
    for delegate in managed:
        doc = frappe.get_doc("User", delegate)
        doc.set("medvisitpro_brands", [])
        for b in brands:
            doc.append("medvisitpro_brands", {"brand": b})
        doc.save(ignore_permissions=True)


@frappe.whitelist()
def update_delegate(name, full_name, mobile_no=None, also_manager=False, enabled=1,
                     primary_territory=None, secondary_territory=None, brands=None):
    """Lets a Delegate Manager edit an existing delegate: their name,
    mobile, active/disabled state, and coverage territory. Email is the
    login identity and is intentionally not editable here.

    Granting/revoking Delegate Manager access, and setting a Delegate
    Manager's own brands, are Regional-Manager-only actions — see
    _require_regional_manager. A plain delegate's brands aren't
    editable here at all; they mirror whichever manager created them
    (medvisitpro_manager) and only move when that manager's brands do,
    via _sync_managed_delegates_brands.

    `brands` is a JSON list of Brand names, read only when the target
    is (or is becoming) a Delegate Manager, replacing their current set
    wholesale — simpler than diffing add/remove, and this is a small
    child table edited from one form, not a high-frequency write.

    Validation failures return {"ok": False, ...} (200) rather than
    frappe.throw — see the note in create_customer for why."""
    _require_manager()

    if not frappe.db.exists("User", name) or "Delegate" not in frappe.get_roles(name):
        return {"ok": False, "error": _("This delegate no longer exists.")}
    if not (full_name or "").strip():
        return {"ok": False, "error": _("Full name is required.")}

    also_manager = also_manager in (True, "true", "1", 1)
    enabled = 0 if enabled in (False, "false", "0", 0) else 1

    user = frappe.get_doc("User", name)
    has_manager = "Delegate Manager" in [r.role for r in user.roles]

    # Only a Regional Manager promotes/demotes Delegate Manager access,
    # or touches a Delegate Manager's own brand list — the whole point
    # of that role is being the one place brand scoping enters the
    # system above plain delegate creation.
    if also_manager != has_manager:
        _require_regional_manager()
    if also_manager and brands is not None:
        _require_regional_manager()

    # A manager editing their own record can't lock themselves out
    # mid-session by disabling the account or dropping manager access.
    if name == frappe.session.user:
        if not enabled:
            return {"ok": False, "error": _("You cannot disable your own account.")}
        if not also_manager:
            return {"ok": False, "error": _("You cannot remove your own manager access.")}

    # Territory is field coverage — it only means anything for someone
    # actually visiting clients. A Delegate Manager doesn't get one,
    # regardless of what the form sends: cleared here rather than just
    # hidden client-side, so it can't linger from before a promotion or
    # be set by calling this API directly.
    if also_manager:
        primary_territory = None
        secondary_territory = None
    elif secondary_territory and not primary_territory:
        return {"ok": False, "error": _("Set a primary territory before a secondary one.")}

    name_parts = full_name.strip().split(" ", 1)
    user.first_name = name_parts[0]
    user.last_name = name_parts[1] if len(name_parts) > 1 else ""
    user.mobile_no = mobile_no
    user.enabled = enabled
    user.primary_territory = primary_territory or None
    user.secondary_territory = secondary_territory or None

    if also_manager and brands is not None:
        brand_list = json.loads(brands) if isinstance(brands, str) else brands
        user.set("medvisitpro_brands", [])
        for b in brand_list:
            if b:
                user.append("medvisitpro_brands", {"brand": b})

    try:
        # enforce_secondary_territory (user_hooks.py) raises on a
        # secondary territory that's inside Kigali — the one rule here
        # that can't be checked before touching the document.
        user.save(ignore_permissions=True)
    except frappe.ValidationError as e:
        return {"ok": False, "error": str(e)}

    # add_roles / remove_roles are no-ops if the role is already in the
    # desired state, so guard to avoid needless writes.
    if also_manager and not has_manager:
        user.add_roles("Delegate Manager")
    elif not also_manager and has_manager:
        user.remove_roles("Delegate Manager")

    if also_manager and brands is not None:
        _sync_managed_delegates_brands(name)

    frappe.db.commit()
    return {"ok": True}


@frappe.whitelist()
def list_delegate_managers():
    """Delegate Managers a Regional Manager can reassign a delegate to —
    powers the 'Reports To' picker in the Edit Delegate modal.

    Regional-Manager-only, and still brand-scoped: a Regional Manager
    only ever moves a delegate between managers inside their own brand
    reach, the same boundary every other method here respects. Disabled
    managers are left out — you don't hand a live team to a dead account
    (the delegate's *current* manager rides in separately via
    get_delegate, so an existing link to a disabled manager still shows).
    """
    _require_regional_manager()

    manager_users = frappe.get_all(
        "Has Role", filters={"role": "Delegate Manager", "parenttype": "User"}, pluck="parent"
    )
    visible = _visible_delegates()
    if visible is not None:
        manager_users = [m for m in manager_users if m in set(visible)]
    if not manager_users:
        return []
    return frappe.get_all(
        "User",
        filters={"name": ["in", manager_users], "enabled": 1},
        fields=["name", "full_name"],
        order_by="full_name asc",
    )


@frappe.whitelist()
def reassign_delegate(delegate, new_manager):
    """Move a field delegate from one Delegate Manager to another —
    Regional-Manager-only (see _require_regional_manager).

    In the brand-scoping model a delegate's brands mirror whoever owns
    them (medvisitpro_manager), so reassigning ownership also re-inherits
    the new manager's brands wholesale — exactly what create_delegate does
    at onboarding and _sync_managed_delegates_brands does on an ongoing
    basis. That's what keeps a manager's whole team scoped to the same
    brand(s), and it's the point of this action: the delegate leaves the
    old team's brand reach and joins the new one's.

    Only a plain field delegate is reassignable. A Delegate Manager owns
    their own brand list (set by a Regional Manager, not inherited) and
    isn't owned by another manager, so there's no medvisitpro_manager on
    them to move — see _is_plain_delegate.

    Validation failures return {"ok": False, ...} (200) rather than
    frappe.throw — see the note in create_customer for why."""
    _require_regional_manager()

    if not frappe.db.exists("User", delegate) or "Delegate" not in frappe.get_roles(delegate):
        return {"ok": False, "error": _("This delegate no longer exists.")}
    if not _is_plain_delegate(delegate):
        return {"ok": False, "error": _(
            "Only a field delegate can be reassigned — a Delegate Manager owns their own brands."
        )}
    if not frappe.db.exists("User", new_manager) or "Delegate Manager" not in frappe.get_roles(new_manager):
        return {"ok": False, "error": _("Choose a Delegate Manager to assign this delegate to.")}

    # Both ends must sit inside the Regional Manager's own brand scope —
    # they can't hand a delegate off to a team they can't see, nor move
    # one they were never able to see in the first place.
    _assert_delegate_visible(delegate)
    _assert_delegate_visible(new_manager)

    doc = frappe.get_doc("User", delegate)
    doc.medvisitpro_manager = new_manager
    doc.set("medvisitpro_brands", [])
    for b in user_brands(new_manager):
        doc.append("medvisitpro_brands", {"brand": b})
    doc.save(ignore_permissions=True)
    frappe.db.commit()

    return {"ok": True}


@frappe.whitelist()
def delete_delegate(name):
    """Removes a Delegate or Delegate Manager account outright — for
    one that was never really used (added by mistake, a duplicate, a
    test account). Anyone with a real track record is refused here and
    should be disabled instead (the `enabled` flag on update_delegate):
    deleting them would either be blocked by Frappe's own link-check
    on their Visits/Assignments, or — force-deleted — take that logged
    history down with them, which isn't acceptable for a compliance-
    sensitive app. A Delegate Manager still being reported to by other
    delegates is refused the same way, so nobody's brand-lock
    (medvisitpro_manager) is left pointing at a name that no longer
    exists."""
    _require_manager()

    if not frappe.db.exists("User", name) or "Delegate" not in frappe.get_roles(name):
        return {"ok": False, "error": _("This delegate no longer exists.")}
    if name == frappe.session.user:
        return {"ok": False, "error": _("You cannot delete your own account.")}

    is_manager = "Delegate Manager" in frappe.get_roles(name)
    if is_manager:
        _require_regional_manager()
    else:
        _assert_delegate_visible(name)

    blockers = []
    visit_count = frappe.db.count("Visit", {"delegate": name})
    if visit_count:
        blockers.append(_("{0} logged visit(s)").format(visit_count))
    assignment_count = frappe.db.count("Visit Assignment", {"delegate": name})
    if assignment_count:
        blockers.append(_("{0} visit assignment(s)").format(assignment_count))
    client_count = frappe.db.count("Customer", {"assigned_delegate": name})
    if client_count:
        blockers.append(_("{0} assigned client(s)").format(client_count))
    plan_count = frappe.db.count("Weekly Visit Plan", {"delegate": name})
    if plan_count:
        blockers.append(_("{0} weekly visit plan(s)").format(plan_count))
    if is_manager:
        managed_count = frappe.db.count("User", {"medvisitpro_manager": name})
        if managed_count:
            blockers.append(_("{0} delegate(s) reporting to them").format(managed_count))

    if blockers:
        label = frappe.db.get_value("User", name, "full_name") or name
        return {"ok": False, "error": _(
            "{0} has history on file ({1}) and can't be deleted. Disable the account instead — "
            "it keeps their history intact but stops them from logging in."
        ).format(label, ", ".join(blockers))}

    frappe.delete_doc("User", name, ignore_permissions=True)
    frappe.db.commit()
    return {"ok": True}


# ============================================================
# Weekly Visit Plans — delegate proposes, manager approves
# ============================================================
# The delegate builds a plan for a week and sends it up; only once a
# Delegate Manager approves a line does it become a real Visit
# Assignment they can act on. Ad-hoc visits run through the same gate:
# a mid-week request for an unplanned client is appended to that same
# week's plan with a reason, and the delegate can't check in until the
# manager clears it.
#
# assign_visit is the one path that skips all this — a manager
# creating an assignment directly IS the approval.


def _plan_line_dict(line):
    customer = frappe.db.get_value(
        "Customer", line.customer,
        ["customer_name", "customer_category", "expected_visits_per_month"],
        as_dict=True,
    ) or {}
    contact_designation = (
        frappe.db.get_value("Contact", line.contact_person, "designation") if line.contact_person else None
    )
    return {
        "row": line.name,
        "customer": line.customer,
        "customer_name": customer.get("customer_name") or line.customer,
        # Org-Type ("clinic", "hospital", ...) and how many visits/month
        # this client is expected to get — both let the delegate see,
        # right on the plan line, whether they're covering this client
        # at the cadence its class calls for, not just who and when.
        "customer_category": customer.get("customer_category"),
        "expected_visits_per_month": customer.get("expected_visits_per_month"),
        "contact_person": line.contact_person,
        "contact_person_name": _contact_display_name(line.contact_person),
        "contact_speciality": contact_designation,
        "scheduled_date": str(line.scheduled_date) if line.scheduled_date else None,
        "scheduled_time": str(line.scheduled_time) if line.scheduled_time else None,
        "visit_type": line.visit_type or "Scheduled",
        "reason": line.reason,
        "approval_status": line.approval_status,
        "manager_comment": line.manager_comment,
        "visit_assignment": line.visit_assignment,
    }


def _plan_dict(doc):
    lines = [_plan_line_dict(ln) for ln in doc.planned_visits]
    return {
        "name": doc.name,
        "delegate": doc.delegate,
        "delegate_name": frappe.db.get_value("User", doc.delegate, "full_name") or doc.delegate,
        "week_start_date": str(doc.week_start_date),
        "status": doc.status,
        "submitted_on": str(doc.submitted_on) if doc.submitted_on else None,
        "reviewed_by": doc.reviewed_by,
        "reviewed_on": str(doc.reviewed_on) if doc.reviewed_on else None,
        "manager_comment": doc.manager_comment,
        "editable": doc.status in ("Draft", "Rejected", "Partially Approved"),
        "lines": lines,
        "counts": {
            "total": len(lines),
            "pending": len([l for l in lines if l["approval_status"] == "Pending"]),
            "approved": len([l for l in lines if l["approval_status"] == "Approved"]),
            "rejected": len([l for l in lines if l["approval_status"] == "Rejected"]),
            "pending_adhoc": len([
                l for l in lines
                if l["approval_status"] == "Pending" and l["visit_type"] == "Ad-hoc"
            ]),
        },
    }


def _get_plan(delegate, week_start_date):
    name = frappe.db.exists(
        "Weekly Visit Plan", {"delegate": delegate, "week_start_date": week_start_date}
    )
    return frappe.get_doc("Weekly Visit Plan", name) if name else None


@frappe.whitelist()
def get_week_plan(week_start_date=None):
    """The logged-in delegate's plan for one week. Returns a null plan
    (rather than throwing) when they haven't started one yet, so the
    page can render an empty planner without a special case."""
    _require_delegate()

    week_start_date = _week_start(week_start_date)
    doc = _get_plan(frappe.session.user, week_start_date)

    return {
        "week_start_date": str(week_start_date),
        "plan": _plan_dict(doc) if doc else None,
    }


@frappe.whitelist()
def save_week_plan(week_start_date, lines):
    """Create or update the delegate's draft plan for a week.

    The payload only ever replaces the Scheduled lines still in play.
    Approved lines are untouchable (they've become real assignments)
    and Ad-hoc lines are left alone too — those are raised from the
    field, not from the weekly planner, and a save here must not wipe
    a request the delegate is waiting on."""
    _require_delegate()

    week_start_date = _week_start(week_start_date)
    if isinstance(lines, str):
        lines = json.loads(lines)

    # A week that has already ended can't be planned for — every line
    # in it would fail the past-date check at submit time anyway.
    if getdate(add_days(week_start_date, 6)) < getdate(nowdate()):
        frappe.throw(_("That week is already over."), title=_("Past Week"))

    doc = _get_plan(frappe.session.user, week_start_date)
    if doc is None:
        doc = frappe.new_doc("Weekly Visit Plan")
        doc.delegate = frappe.session.user
        doc.week_start_date = week_start_date
        doc.status = "Draft"
    elif doc.status == "Pending Approval":
        frappe.throw(
            _("This plan is with your manager for approval and can't be edited."),
            title=_("Under Review"),
        )
    elif doc.status == "Approved":
        frappe.throw(_("This plan is fully approved."), title=_("Already Approved"))

    kept = [
        ln for ln in doc.planned_visits
        if ln.approval_status == "Approved" or ln.visit_type == "Ad-hoc"
    ]
    doc.planned_visits = []
    for ln in kept:
        doc.append("planned_visits", {
            "customer": ln.customer,
            "contact_person": ln.contact_person,
            "scheduled_date": ln.scheduled_date,
            "scheduled_time": ln.scheduled_time,
            "visit_type": ln.visit_type,
            "reason": ln.reason,
            "approval_status": ln.approval_status,
            "manager_comment": ln.manager_comment,
            "visit_assignment": ln.visit_assignment,
        })

    for ln in lines:
        doc.append("planned_visits", {
            "customer": ln.get("customer"),
            "contact_person": ln.get("contact_person") or None,
            "scheduled_date": ln.get("scheduled_date"),
            "scheduled_time": ln.get("scheduled_time") or None,
            "visit_type": "Scheduled",
            "approval_status": "Pending",
        })

    doc.save(ignore_permissions=True)
    frappe.db.commit()

    return {"ok": True, "plan": _plan_dict(doc)}


@frappe.whitelist()
def submit_week_plan(week_start_date):
    """Send the week up for approval."""
    _require_delegate()

    week_start_date = _week_start(week_start_date)
    doc = _get_plan(frappe.session.user, week_start_date)
    if doc is None:
        frappe.throw(_("You haven't planned any visits for that week yet."))

    doc.submit_for_approval()
    frappe.db.commit()

    return {"ok": True, "plan": _plan_dict(doc)}


@frappe.whitelist()
def request_adhoc_visit(customer, reason, contact_person=None):
    """Delegate asks to visit a client the week's plan didn't cover.

    This replaces the old create_adhoc_assignment, which made the
    assignment outright — ad-hoc visits are now approved like
    everything else, so this only lodges the request. The delegate
    polls get_week_plan (or reloads) to see the decision, and the
    Visit Assignment only appears once the manager approves."""
    _require_delegate()

    week_start_date = _week_start()
    doc = _get_plan(frappe.session.user, week_start_date)
    if doc is None:
        doc = frappe.new_doc("Weekly Visit Plan")
        doc.delegate = frappe.session.user
        doc.week_start_date = week_start_date
        doc.status = "Draft"
        doc.insert(ignore_permissions=True)

    line = doc.add_adhoc_request(customer, reason, contact_person)
    frappe.db.commit()

    return {"ok": True, "row": line.name, "plan": _plan_dict(doc)}


@frappe.whitelist()
def list_plan_approvals(status="Pending Approval", week_start_date=None):
    """Plans across the whole team for the manager's review queue.

    `status` accepts "All" to drop the filter — useful for looking
    back at what was already decided."""
    _require_manager()

    filters = _scope_to_delegates({})
    if filters is None:
        return {"plans": [], "pending_count": 0}
    if status and status != "All":
        filters["status"] = status
    if week_start_date:
        filters["week_start_date"] = _week_start(week_start_date)

    plans = frappe.get_all(
        "Weekly Visit Plan",
        filters=filters,
        fields=["name", "delegate", "week_start_date", "status", "submitted_on"],
        order_by="submitted_on asc, modified asc",
        limit_page_length=100,
    )

    for p in plans:
        p["delegate_name"] = frappe.db.get_value("User", p.delegate, "full_name") or p.delegate
        p["week_start_date"] = str(p.week_start_date)
        p["submitted_on"] = str(p.submitted_on) if p.submitted_on else None

        rows = frappe.get_all(
            "Weekly Visit Plan Item",
            filters={"parent": p.name},
            fields=["approval_status", "visit_type"],
        )
        p["total_visits"] = len(rows)
        p["pending_visits"] = len([r for r in rows if r.approval_status == "Pending"])
        # Surfaced separately so the queue can float ad-hoc requests to
        # the top — a delegate is standing in front of a client waiting
        # on those, where a next-week plan can sit a while.
        p["pending_adhoc"] = len([
            r for r in rows if r.approval_status == "Pending" and r.visit_type == "Ad-hoc"
        ])

    pending_filters = dict(filters)
    pending_filters["status"] = "Pending Approval"
    return {
        "plans": plans,
        "pending_count": frappe.db.count("Weekly Visit Plan", pending_filters),
    }


@frappe.whitelist()
def get_plan_details(plan):
    """Full plan with its lines, for the manager's review panel."""
    _require_manager()
    doc = frappe.get_doc("Weekly Visit Plan", plan)
    _assert_delegate_visible(doc.delegate)
    return _plan_dict(doc)


@frappe.whitelist()
def decide_plan_visit(plan, row, decision, comment=None):
    """Approve or reject one planned visit. Approving it creates the
    Visit Assignment on the spot."""
    _require_manager()

    doc = frappe.get_doc("Weekly Visit Plan", plan)
    _assert_delegate_visible(doc.delegate)
    doc.decide_line(row, decision, comment)
    frappe.db.commit()

    return {"ok": True, "plan": _plan_dict(doc)}


@frappe.whitelist()
def approve_plan(plan):
    """Approve every still-pending visit in the plan at once."""
    _require_manager()

    doc = frappe.get_doc("Weekly Visit Plan", plan)
    _assert_delegate_visible(doc.delegate)
    doc.approve_all()
    frappe.db.commit()

    return {"ok": True, "plan": _plan_dict(doc)}


@frappe.whitelist()
def reject_plan(plan, comment):
    """Send the whole week back to the delegate with a reason."""
    _require_manager()

    doc = frappe.get_doc("Weekly Visit Plan", plan)
    _assert_delegate_visible(doc.delegate)
    doc.reject_all(comment)
    frappe.db.commit()

    return {"ok": True, "plan": _plan_dict(doc)}


# ============================================================
# Bulk client import
# ============================================================
# A manager downloads a template, fills it in, and uploads it back as
# .xlsx or .csv. The column spec below is the single source of truth
# for both directions — the template is generated from it and uploads
# are matched against it, so renaming a column here changes both at
# once and they can never drift apart.
#
# Matching is case- and space-insensitive, so a client who retypes the
# header or exports from another tool still imports cleanly.

CLIENT_IMPORT_COLUMNS = [
    # (header, field, required, example)
    #
    # Client ID leads the sheet and is deliberately NOT required. Leave it
    # empty and the row creates a new client; fill it in — from an export
    # — and the row updates that client instead of making a second copy of
    # them. Requiring an export first is what stops a stale file quietly
    # overwriting live records.
    ("Client ID", "client_id", False, ""),
    ("Client Name", "customer_name", True, "Kigali Central Pharmacy"),
    ("Client Type", "customer_type", False, "Company"),
    ("Category", "customer_category", False, "Pharmacy"),
    ("Client Class", "customer_class", False, "Supercore"),
    ("Phone", "phone", True, "+250788123456"),
    # Optional, but unique when given — the same rule as Phone. Most
    # existing clients have never had an email on file, so it can't be
    # required without breaking every update row for them.
    ("Email", "email", False, "info@kigalicentral.rw"),
    ("Contact Person", "contact_person", False, "Jean Uwimana"),
    ("Address", "address_line1", False, "KN 4 Ave"),
    ("City", "city", False, "Kigali"),
]

# Look the example up by field name. It used to be read positionally
# (CLIENT_IMPORT_COLUMNS[0][3] and [4][3]) to spot the template's sample
# row, which silently pointed at the wrong columns the moment one was
# added in front.
EXAMPLE_BY_FIELD = {field: example for _h, field, _r, example in CLIENT_IMPORT_COLUMNS}

VALID_CUSTOMER_TYPES = ("Company", "Individual")
VALID_CATEGORIES = ("Pharmacy", "Clinic", "Hospital")
VALID_CLASSES = ("Supercore", "Core", "Noncore")

# A phone is this app's uniqueness key for a client, so a mistyped one
# doesn't just look wrong — it creates a client that a later, correct
# import can no longer match. Local numbers run to 10 digits and
# international ones to 12 (country code + 9), so anything outside
# that is a typo rather than a number we've not seen before.
MIN_PHONE_DIGITS = 10
MAX_PHONE_DIGITS = 12


def _normalise_header(value):
    return " ".join(str(value or "").strip().lower().split())


def _clean_phone(value):
    """Strip the punctuation people type into spreadsheets — spaces,
    dashes, dots, brackets — keeping an optional leading +. Returns
    (cleaned, digits) so callers can validate and store separately."""
    raw = str(value or "").strip()
    plus = raw.startswith("+")
    body = raw.lstrip("+")
    for ch in (" ", "-", ".", "(", ")", " ", "/"):
        body = body.replace(ch, "")
    return ("+" if plus else "") + body, body


def _validate_phone(value):
    """Returns (cleaned_phone, error_message). error_message is None
    when the number is usable."""
    cleaned, digits = _clean_phone(value)

    if not digits:
        return cleaned, _("Phone is empty.")
    if not digits.isdigit():
        return cleaned, _("Phone contains characters that aren't digits: {0}").format(cleaned)
    if len(digits) < MIN_PHONE_DIGITS:
        return cleaned, _("Phone has only {0} digits — expected at least {1}.").format(
            len(digits), MIN_PHONE_DIGITS
        )
    if len(digits) > MAX_PHONE_DIGITS:
        return cleaned, _("Phone has {0} digits — expected at most {1}.").format(
            len(digits), MAX_PHONE_DIGITS
        )
    return cleaned, None


def _template_rows():
    """Header row plus one filled-in example, so it's obvious what
    each column wants without reading separate instructions."""
    return [
        [c[0] for c in CLIENT_IMPORT_COLUMNS],
        [c[3] for c in CLIENT_IMPORT_COLUMNS],
    ]


def _export_field_values(c):
    """One client's exportable values, keyed exactly like
    CLIENT_IMPORT_COLUMNS' field names — so a caller can pick whichever
    subset of columns it wants without re-deriving anything.

    `c` is a Customer dict already carrying name, medvisitpro_client_id,
    customer_name, customer_type, customer_category, customer_class, and
    (for the delegate/geo columns) assigned_delegate, province, district."""
    address_line1, city = "", ""
    address_name = frappe.db.get_value(
        "Dynamic Link",
        {"link_doctype": "Customer", "link_name": c.name, "parenttype": "Address"},
        "parent",
    )
    if address_name:
        addr = frappe.db.get_value(
            "Address", address_name, ["address_line1", "city"], as_dict=True
        )
        if addr:
            address_line1 = addr.address_line1 or ""
            city = addr.city or ""

    contact_name = _customer_contact_name(c.name)
    contact_person = ""
    if contact_name:
        contact_person = frappe.db.get_value("Contact", contact_name, "first_name") or ""

    return {
        "client_id": c.medvisitpro_client_id or "",
        "customer_name": c.customer_name or "",
        "customer_type": c.customer_type or "",
        "customer_category": c.customer_category or "",
        "customer_class": c.customer_class or "",
        "phone": _customer_phone(c.name) or "",
        "email": _customer_email(c.name) or "",
        "contact_person": contact_person,
        "address_line1": address_line1,
        "city": city,
        "assigned_delegate_email": (
            frappe.db.get_value("User", c.assigned_delegate, "email") if c.get("assigned_delegate") else ""
        ),
        "province": c.get("province") or "",
        "district": c.get("district") or "",
    }


def _export_rows(customer_names=None, columns=None):
    """Header row plus the client list, with their Client ID filled in.
    This is the other half of the update flow: download, edit in a
    spreadsheet, upload again. The IDs travelling out and back are what
    let the re-upload change those clients instead of trying to create
    them a second time.

    `customer_names`, when given, restricts the export to that set of
    record names — the manager's row selection on the Client List table.
    None means every enabled client, which is also what an empty
    selection falls back to (see download_client_template).

    `columns`, when given, restricts which fields are included, kept in
    CLIENT_IMPORT_COLUMNS order regardless of the order they were
    selected in. None (or a selection matching nothing) means every
    column — an export with no columns at all isn't a file, so that
    case falls back to the full set rather than producing a blank sheet.
    """
    spec = CLIENT_IMPORT_COLUMNS
    if columns is not None:
        wanted = set(columns)
        narrowed = [c for c in CLIENT_IMPORT_COLUMNS if c[1] in wanted]
        if narrowed:
            spec = narrowed

    rows = [[c[0] for c in spec]]

    filters = {"is_medvisitpro_enabled": 1}
    if customer_names is not None:
        filters["name"] = ["in", customer_names]

    customers = frappe.get_all(
        "Customer",
        filters=filters,
        fields=[
            "name", "medvisitpro_client_id", "customer_name",
            "customer_type", "customer_category", "customer_class",
            "assigned_delegate", "province", "district",
        ],
        order_by="customer_name asc",
        limit_page_length=0,
    )

    for c in customers:
        values = _export_field_values(c)
        rows.append([values[field] for _h, field, _r, _e in spec])

    return rows


@frappe.whitelist()
def list_client_columns():
    """The exportable client columns, for the gear-icon panel's column
    checklist. A single source of truth rather than a copy of
    CLIENT_IMPORT_COLUMNS hardcoded into the JS: the two would drift the
    first time a column was added here and forgotten there — precisely
    the class of bug the shared Tailwind config in this app was written
    to avoid.

    `recommended` flags Client ID specifically: technically optional to
    export, but unchecking it is what turns a re-upload from an update
    into an accidental duplicate-creation."""
    _require_manager()
    return [
        {"field": field, "label": header, "recommended": field == "client_id"}
        for header, field, _required, _example in CLIENT_IMPORT_COLUMNS
    ]


@frappe.whitelist(methods=["GET"])
def download_client_template(fmt="xlsx", mode="template", customers=None, columns=None):
    """Serves the blank import template, or the current client list.

    GET so the browser can just open it as a download rather than
    round-tripping through JS.

    mode="template" — headers plus one worked example, for adding clients.
                      Always the full column set; picking columns only
                      makes sense for data that already exists.
    mode="export"   — headers plus every client with their Client ID, for
                      editing existing ones and uploading the changes back.

    `customers` — comma-separated Customer record names — restricts an
    export to the manager's row selection on the Client List table.
    `columns` — comma-separated field names (see list_client_columns) —
    restricts which columns appear, in the app's fixed order regardless
    of what order they were checked in.

    Both arrive as plain strings: Frappe hands query params to a
    whitelisted method as text, not a list, hence the splits below. A
    blank or missing value falls back to "everything" rather than
    "nothing" — the safer failure if either ever arrived empty by a
    client-side bug rather than deliberate choice.
    """
    _require_manager()

    exporting = mode == "export"
    customer_names = None
    selected = False
    if exporting and customers:
        customer_names = [c.strip() for c in customers.split(",") if c.strip()]
        selected = bool(customer_names)
        if not selected:
            customer_names = None

    column_fields = None
    if exporting and columns:
        column_fields = [c.strip() for c in columns.split(",") if c.strip()]
        if not column_fields:
            column_fields = None

    rows = _export_rows(customer_names, column_fields) if exporting else _template_rows()
    stem = "medvisitpro_clients"
    if not exporting:
        stem = "medvisitpro_client_template"
    elif selected:
        stem += "_selected"

    if fmt == "csv":
        import csv
        import io

        buf = io.StringIO()
        csv.writer(buf).writerows(rows)
        content = buf.getvalue()
        filename = f"{stem}.csv"
    else:
        from frappe.utils.xlsxutils import make_xlsx

        xlsx = make_xlsx(rows, "Clients")
        content = xlsx.getvalue()
        filename = f"{stem}.xlsx"

    frappe.response["type"] = "download"
    frappe.response["filename"] = filename
    frappe.response["filecontent"] = content
    frappe.response["content_type"] = (
        "text/csv" if fmt == "csv" else
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )


def _parse_upload(filename, content):
    """Decode an uploaded .xlsx or .csv into a list of row lists.
    Raises rather than returning partial data — a file we can't read
    must not import half of itself."""
    lower = (filename or "").lower()

    if lower.endswith(".csv"):
        import csv
        import io

        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = content.decode("latin-1")
        return [r for r in csv.reader(io.StringIO(text))]

    if lower.endswith((".xlsx", ".xlsm")):
        from frappe.utils.xlsxutils import read_xlsx_file_from_attached_file

        return read_xlsx_file_from_attached_file(fcontent=content)

    frappe.throw(
        _("Unsupported file type. Upload a .xlsx or .csv file."),
        title=_("Bad File"),
    )


# Recognising at least one of these in the header is what separates "a
# file we can work with" from "a file with none of our columns" — see
# _map_columns. Neither Client Name nor Phone can be required at the
# whole-file level any more: a column-selection export (see
# list_client_columns / download_client_template) can leave either one
# out entirely and still be a perfectly good update-only file, since an
# update row's missing name/phone just means "leave unchanged" (see
# _apply_client_update). What genuinely can't be created without a name
# and phone is a brand-new client — and that requirement is enforced per
# row, in import_clients, exactly where "is this row a create" is known.
_ANY_OF_FIELDS = ("client_id", "customer_name", "phone")


def _map_columns(header_row):
    """Match the uploaded header row to our column spec. Returns
    {field: column_index}. Unknown columns are ignored, so a client
    can keep their own extra columns in the file.

    Does NOT enforce that any particular column is present — a file
    built from a custom export may only carry a handful of them. It
    does refuse a file that matches none of our columns at all, since
    every row would otherwise fail with an obscure per-field message
    instead of one clear one up front."""
    seen = {}
    for idx, cell in enumerate(header_row):
        seen.setdefault(_normalise_header(cell), idx)

    mapping = {}
    for header, field, _required, _example in CLIENT_IMPORT_COLUMNS:
        idx = seen.get(_normalise_header(header))
        if idx is not None:
            mapping[field] = idx

    if not any(f in mapping for f in _ANY_OF_FIELDS):
        frappe.throw(
            _(
                "None of the columns in this file were recognised. Download the "
                "template, or export your client list, and use its header row."
            ),
            title=_("Wrong Columns"),
        )
    return mapping


def _cell(row, mapping, field):
    idx = mapping.get(field)
    if idx is None or idx >= len(row):
        return ""
    value = row[idx]
    if value is None:
        return ""
    return str(value).strip()


def _match_choice(value, choices):
    """Case-insensitive match against an allowed set. Returns None when
    the value doesn't match, so the caller can report the row."""
    for c in choices:
        if value.lower() == c.lower():
            return c
    return None


def _apply_client_update(row, mapping, client_id, offset):
    """Update the client owning `client_id` from this row.

    A blank cell means "leave unchanged" — the normal case is a sheet
    carrying only the columns being changed, and treating blanks as
    deletions would let one re-uploaded export wipe categories, classes
    and addresses across the whole list.

    Returns (ok, entry) where entry is the row's result record.
    """
    customer = frappe.db.get_value("Customer", {"medvisitpro_client_id": client_id}, "name")
    if not customer:
        return False, {
            "row": offset, "column": "Client ID", "value": client_id,
            "reason": _("No client has the ID {0}. Export the client list to get valid IDs.").format(client_id),
        }

    # Assigned Delegate / Province / District are validated up front so a
    # bad value fails the row before anything is written; they're applied
    # after the core save below (they live directly on the Customer).
    extra, geo_error = _client_geo_and_delegate_from_row(row, mapping, current_customer=customer)
    if geo_error:
        return False, {
            "row": offset,
            "name": frappe.db.get_value("Customer", customer, "customer_name"),
            "column": "Assigned Delegate / Province / District",
            "value": "", "reason": geo_error,
        }

    doc = frappe.get_doc("Customer", customer)
    label = doc.customer_name
    changed = []

    name = _cell(row, mapping, "customer_name")
    if name and name != doc.customer_name:
        doc.customer_name = name
        changed.append("name")

    for field, choices, column in (
        ("customer_type", VALID_CUSTOMER_TYPES, "Client Type"),
        ("customer_category", VALID_CATEGORIES, "Category"),
        ("customer_class", VALID_CLASSES, "Client Class"),
    ):
        value = _cell(row, mapping, field)
        if not value:
            continue
        matched = _match_choice(value, choices)
        if not matched:
            return False, {
                "row": offset, "name": label, "column": column, "value": value,
                "reason": _("{0} must be one of: {1}.").format(column, ", ".join(choices)),
            }
        if matched != doc.get(field):
            doc.set(field, matched)
            changed.append(column.lower())

    # The phone may move to a new number, but never to one that already
    # belongs to somebody else — that would merge two clients by accident.
    raw_phone = _cell(row, mapping, "phone")
    new_phone = None
    if raw_phone:
        phone, phone_error = _validate_phone(raw_phone)
        if phone_error:
            return False, {
                "row": offset, "name": label, "column": "Phone",
                "value": raw_phone, "reason": phone_error,
            }
        owner = _customer_id_with_phone(phone)
        if owner and owner != customer:
            return False, {
                "row": offset, "name": label, "column": "Phone", "value": phone,
                "reason": _("That phone number already belongs to {0}.").format(
                    frappe.db.get_value("Customer", owner, "customer_name") or owner
                ),
            }
        if not owner:
            new_phone = phone

    # Same rule for email: may change, never to one owned by someone else.
    raw_email = _cell(row, mapping, "email")
    new_email = None
    if raw_email:
        email, email_error = _validate_email(raw_email)
        if email_error:
            return False, {
                "row": offset, "name": label, "column": "Email",
                "value": raw_email, "reason": email_error,
            }
        owner = _customer_id_with_email(email)
        if owner and owner != customer:
            return False, {
                "row": offset, "name": label, "column": "Email", "value": email,
                "reason": _("That email already belongs to {0}.").format(
                    frappe.db.get_value("Customer", owner, "customer_name") or owner
                ),
            }
        if not owner:
            new_email = email

    doc.save(ignore_permissions=True)

    if new_phone:
        _set_customer_phone(customer, new_phone)
        changed.append("phone")

    if new_email:
        _set_customer_email(customer, new_email)
        changed.append("email")

    address_line1 = _cell(row, mapping, "address_line1")
    city = _cell(row, mapping, "city")
    if address_line1 or city:
        _set_customer_address(customer, address_line1, city)
        changed.append("address")

    if extra:
        frappe.db.set_value("Customer", customer, extra)
        for key in ("assigned_delegate", "province", "district"):
            if key in extra:
                changed.append(key.replace("_", " "))

    return True, {
        "row": offset,
        "name": doc.customer_name,
        "customer": customer,
        "client_id": client_id,
        "changed": changed,
        "reason": None if changed else _("Row matched but nothing differed."),
    }


@frappe.whitelist()
def import_clients(filename, content):
    """Bulk-create clients from an uploaded template.

    Rows are independent: a bad row is skipped and reported by its
    line number rather than aborting the file, and a client whose
    phone already exists is skipped too (phone is the uniqueness key —
    see create_customer). Only a file we can't read at all, or one
    whose header row is wrong, fails outright before anything is
    created."""
    _require_manager()

    import base64

    try:
        raw = base64.b64decode(content)
    except Exception:
        frappe.throw(_("The upload was corrupted in transit. Try again."), title=_("Bad Upload"))

    rows = _parse_upload(filename, raw)
    rows = [r for r in rows if any(str(c or "").strip() for c in r)]
    if len(rows) < 2:
        frappe.throw(
            _("That file has a header row but no clients in it."),
            title=_("Nothing To Import"),
        )

    mapping = _map_columns(rows[0])

    created, updated, skipped, failed = [], [], [], []
    # Phones/emails already used by an earlier row of THIS file. Phone is
    # keyed by subscriber digits so two rows written in different formats
    # still collide; email by the cleaned lowercase address. Both let a
    # clash inside the upload name the row it collides with, rather than
    # just saying "already exists".
    phones_in_file = {}
    emails_in_file = {}

    for offset, row in enumerate(rows[1:], start=2):
        name = _cell(row, mapping, "customer_name")
        raw_phone = _cell(row, mapping, "phone")
        client_id = _cell(row, mapping, "client_id")

        # A row carrying a Client ID updates that client rather than
        # creating one. Name and phone are optional on these rows —
        # blank means leave as-is — so this branch comes before the
        # required-field checks below.
        if client_id:
            savepoint = f"upd_{offset}"
            frappe.db.savepoint(savepoint)
            try:
                ok, entry = _apply_client_update(row, mapping, client_id, offset)
            except Exception as e:
                ok, entry = False, {"row": offset, "name": name, "reason": str(e)}
            if ok:
                updated.append(entry)
            else:
                frappe.db.rollback(save_point=savepoint)
                failed.append(entry)
            continue

        if not name:
            failed.append({
                "row": offset, "column": "Client Name",
                "value": "", "reason": _("Client Name is empty."),
            })
            continue

        # The template ships an example row; skip it rather than
        # importing a fake client when someone forgets to clear it.
        if (
            name == EXAMPLE_BY_FIELD["customer_name"]
            and raw_phone == EXAMPLE_BY_FIELD["phone"]
        ):
            skipped.append({"row": offset, "name": name, "reason": _("Template example row.")})
            continue

        phone, phone_error = _validate_phone(raw_phone)
        if phone_error:
            failed.append({
                "row": offset, "name": name, "column": "Phone",
                "value": raw_phone, "reason": phone_error,
            })
            continue

        earlier_row = phones_in_file.get(_phone_match_key(phone))
        if earlier_row:
            skipped.append({
                "row": offset, "name": name, "column": "Phone", "value": phone,
                "reason": _("Same phone as row {0} ({1}) in this file.").format(
                    earlier_row["row"], earlier_row["name"]
                ),
            })
            continue

        existing = _customer_with_phone(phone)
        if existing:
            skipped.append({
                "row": offset, "name": name, "column": "Phone", "value": phone,
                "reason": _(
                    "Phone already belongs to existing client {0}. To change that "
                    "client instead, export the list and re-upload the row with its "
                    "Client ID filled in."
                ).format(existing),
            })
            continue

        raw_email = _cell(row, mapping, "email")
        email = ""
        if raw_email:
            email, email_error = _validate_email(raw_email)
            if email_error:
                failed.append({
                    "row": offset, "name": name, "column": "Email",
                    "value": raw_email, "reason": email_error,
                })
                continue

            earlier_email_row = emails_in_file.get(email)
            if earlier_email_row:
                skipped.append({
                    "row": offset, "name": name, "column": "Email", "value": email,
                    "reason": _("Same email as row {0} ({1}) in this file.").format(
                        earlier_email_row["row"], earlier_email_row["name"]
                    ),
                })
                continue

            existing_email = _customer_with_email(email)
            if existing_email:
                skipped.append({
                    "row": offset, "name": name, "column": "Email", "value": email,
                    "reason": _(
                        "Email already belongs to existing client {0}. To change that "
                        "client instead, export the list and re-upload the row with its "
                        "Client ID filled in."
                    ).format(existing_email),
                })
                continue

        customer_type = _cell(row, mapping, "customer_type") or "Company"
        matched_type = _match_choice(customer_type, VALID_CUSTOMER_TYPES)
        if not matched_type:
            failed.append({
                "row": offset, "name": name, "column": "Client Type", "value": customer_type,
                "reason": _("Client Type must be one of: {0}.").format(", ".join(VALID_CUSTOMER_TYPES)),
            })
            continue

        category = _cell(row, mapping, "customer_category")
        matched_category = _match_choice(category, VALID_CATEGORIES) if category else None
        if category and not matched_category:
            failed.append({
                "row": offset, "name": name, "column": "Category", "value": category,
                "reason": _("Category must be one of: {0}.").format(", ".join(VALID_CATEGORIES)),
            })
            continue

        klass = _cell(row, mapping, "customer_class")
        matched_class = _match_choice(klass, VALID_CLASSES) if klass else None
        if klass and not matched_class:
            failed.append({
                "row": offset, "name": name, "column": "Client Class", "value": klass,
                "reason": _("Client Class must be one of: {0}.").format(", ".join(VALID_CLASSES)),
            })
            continue

        # Each row is its own transaction: one bad record can't undo
        # the good ones already written, and can't leave a client
        # without its Contact either.
        savepoint = f"row_{offset}"
        frappe.db.savepoint(savepoint)
        try:
            customer = frappe.new_doc("Customer")
            customer.customer_name = name
            customer.customer_type = matched_type
            customer.customer_category = matched_category
            customer.customer_class = matched_class
            customer.is_medvisitpro_enabled = 1
            customer.insert(ignore_permissions=True)

            contact = frappe.new_doc("Contact")
            contact.first_name = _cell(row, mapping, "contact_person") or name
            contact.append("phone_nos", {"phone": phone, "is_primary_mobile_no": 1})
            if email:
                contact.append("email_ids", {"email_id": email, "is_primary": 1})
            contact.append("links", {"link_doctype": "Customer", "link_name": customer.name})
            contact.insert(ignore_permissions=True)

            address_line1 = _cell(row, mapping, "address_line1")
            if address_line1:
                address = frappe.new_doc("Address")
                address.address_title = name
                address.address_type = "Billing"
                address.address_line1 = address_line1
                address.city = _cell(row, mapping, "city")
                address.append("links", {"link_doctype": "Customer", "link_name": customer.name})
                address.insert(ignore_permissions=True)

            created.append({"row": offset, "name": name, "customer": customer.name})
            phones_in_file[_phone_match_key(phone)] = {"row": offset, "name": name}
            if email:
                emails_in_file[email] = {"row": offset, "name": name}
        except Exception as e:
            frappe.db.rollback(save_point=savepoint)
            failed.append({"row": offset, "name": name, "reason": str(e)})

    # Second pass — Assigned Delegate / Province / District for the rows
    # just created. Updates already picked these up inside
    # _apply_client_update; the create branch above predates the three
    # columns, so rather than thread them through its transaction-per-row
    # body, newly-created clients get them here. A geo/delegate error now
    # undoes the just-created record (it was created before this ran) and
    # moves the row from created to failed, rather than leaving a client
    # silently missing what the row asked for.
    if any(f in mapping for f in ("assigned_delegate_email", "province", "district")):
        created_at_row = {e["row"]: e["customer"] for e in created}
        for offset, row in enumerate(rows[1:], start=2):
            customer = created_at_row.get(offset)
            if not customer:
                continue  # this row updated an existing client; already handled
            extra, error = _client_geo_and_delegate_from_row(row, mapping)
            if error:
                contact = frappe.db.get_value(
                    "Dynamic Link",
                    {"link_doctype": "Customer", "link_name": customer, "parenttype": "Contact"},
                    "parent",
                )
                if contact:
                    frappe.delete_doc("Contact", contact, ignore_permissions=True, force=True)
                frappe.delete_doc("Customer", customer, ignore_permissions=True, force=True)
                created[:] = [e for e in created if e["row"] != offset]
                failed.append({
                    "row": offset, "name": _cell(row, mapping, "customer_name"),
                    "column": "Assigned Delegate / Province / District", "reason": error,
                })
                continue
            if extra:
                frappe.db.set_value("Customer", customer, extra)

    frappe.db.commit()

    return {
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "failed": failed,
        "counts": {
            "created": len(created),
            "updated": len(updated),
            "skipped": len(skipped),
            "failed": len(failed),
            "total": len(rows) - 1,
        },
    }


# ============================================================
# Client ownership: assignment, geography, points of contact
# ============================================================
# A delegate's Assigned Clients are a persistent roster (which
# organizations they own), distinct from a Visit Assignment (which
# visit, which week). One client has exactly one owning delegate at a
# time — reassigning replaces the previous owner rather than adding a
# second one.
#
# "Points of contact" is the other half: a hospital is one Customer but
# may have several named specialists on file (a Cardiologist, a
# Cardiology Fellow, ...), each their own Contact with its own phone.
# designation on Contact IS the speciality — no new field needed there.


@frappe.whitelist()
def list_territories():
    """Every Territory on the site, for the delegate's Primary/Secondary
    Territory selects. Distinct from Province/District: this is the
    coverage-area concept on the delegate, not a client's address."""
    _require_manager()
    return frappe.get_all("Territory", filters={"is_group": 0}, pluck="name", order_by="name asc")


@frappe.whitelist()
def list_all_brands():
    """Every Brand on the site, for the delegate edit form's brand
    checklist. Unlike list_manager_brands, not scoped to the caller's
    own brands — a manager assigning THEMSELVES a first brand, or
    picking from the full catalogue for a delegate, needs to see all
    of them regardless of what they're currently scoped to."""
    _require_manager()
    return frappe.get_all("Brand", pluck="name", order_by="name asc")


@frappe.whitelist()
def list_provinces_districts():
    """Rwanda's province -> district structure, for the Province/District
    selects on the client form (District options follow whichever
    Province is picked)."""
    _require_delegate_or_manager()
    return PROVINCE_DISTRICTS


@frappe.whitelist()
def update_client_geo(customer, province=None, district=None):
    """Sets a client's Province/District from the detail modal — the
    one-off counterpart to setting them via the bulk import."""
    _require_manager()

    if not frappe.db.exists("Customer", customer):
        frappe.throw(_("Client not found"))

    province, district, error = _validate_province_district(province or None, district or None)
    if error:
        return {"ok": False, "error": error}

    frappe.db.set_value("Customer", customer, {"province": province, "district": district})
    frappe.db.commit()
    return {"ok": True}


@frappe.whitelist()
def assign_client(customer, delegate):
    """Manager assigns (or reassigns) a client to a delegate. Brand-
    scoped: a manager can only hand a client to a delegate who shares
    at least one of their brands — the same rule guarding every other
    delegate-facing write in this file."""
    _require_manager()

    if not frappe.db.exists("Customer", customer):
        frappe.throw(_("Client not found"))
    if not _is_plain_delegate(delegate):
        frappe.throw(_("Selected user is not a field delegate — a Delegate Manager can't be assigned a client."))
    _assert_delegate_visible(delegate)

    frappe.db.set_value("Customer", customer, {
        "assigned_delegate": delegate,
        "assigned_on": now_datetime(),
        "assigned_by": frappe.session.user,
    })
    frappe.db.commit()
    return {"ok": True}


@frappe.whitelist()
def unassign_client(customer):
    """Clears a client's owning delegate — e.g. the delegate has left,
    or the account is being handed back to the pool before a
    reassignment."""
    _require_manager()

    if not frappe.db.exists("Customer", customer):
        frappe.throw(_("Client not found"))

    frappe.db.set_value("Customer", customer, {
        "assigned_delegate": None, "assigned_on": None, "assigned_by": None,
    })
    frappe.db.commit()
    return {"ok": True}


@frappe.whitelist()
def delete_client(customer):
    """Removes a Client outright — for one added by mistake or a
    duplicate that was never actually visited. Real history (visits,
    assignments, orders) refuses it, same reasoning as delete_delegate.
    Its points of contact and address are removed along with it —
    neither has any standalone meaning in this app once the client
    they belong to is gone."""
    _require_manager()

    if not frappe.db.exists("Customer", customer):
        return {"ok": False, "error": _("Client not found.")}

    blockers = []
    visit_count = frappe.db.count("Visit", {"customer": customer})
    if visit_count:
        blockers.append(_("{0} logged visit(s)").format(visit_count))
    assignment_count = frappe.db.count("Visit Assignment", {"customer": customer})
    if assignment_count:
        blockers.append(_("{0} visit assignment(s)").format(assignment_count))
    plan_item_count = frappe.db.count("Weekly Visit Plan Item", {"customer": customer})
    if plan_item_count:
        blockers.append(_("{0} weekly plan line(s)").format(plan_item_count))
    order_count = frappe.db.count("Sales Order", {"customer": customer})
    if order_count:
        blockers.append(_("{0} sales order(s)").format(order_count))

    if blockers:
        label = frappe.db.get_value("Customer", customer, "customer_name") or customer
        return {"ok": False, "error": _(
            "{0} has history on file ({1}) and can't be deleted."
        ).format(label, ", ".join(blockers))}

    for contact_name in frappe.get_all(
        "Dynamic Link",
        filters={"link_doctype": "Customer", "link_name": customer, "parenttype": "Contact"},
        pluck="parent",
    ):
        frappe.delete_doc("Contact", contact_name, ignore_permissions=True)
    for address_name in frappe.get_all(
        "Dynamic Link",
        filters={"link_doctype": "Customer", "link_name": customer, "parenttype": "Address"},
        pluck="parent",
    ):
        frappe.delete_doc("Address", address_name, ignore_permissions=True)

    frappe.delete_doc("Customer", customer, ignore_permissions=True)
    frappe.db.commit()
    return {"ok": True}


@frappe.whitelist()
def list_clients_in_territory(territory, txt=""):
    """Clients whose Province matches `territory` — the pool a manager
    picks Responsible Clients from once they've committed to one of the
    delegate's two territories (see bulk_assign_clients). Territory
    names are seeded to match Province exactly (setup_territories,
    setup_custom_fields.py), so this is a plain equality filter rather
    than a lookup through a separate mapping."""
    _require_manager()

    filters = {"is_medvisitpro_enabled": 1, "province": territory}
    if txt:
        filters["customer_name"] = ["like", f"%{txt}%"]

    rows = frappe.get_all(
        "Customer",
        filters=filters,
        fields=[
            "name", "customer_name", "medvisitpro_client_id", "customer_category",
            "customer_class", "district", "assigned_delegate",
        ],
        order_by="customer_name asc",
        limit_page_length=0,
    )

    delegate_ids = {r.assigned_delegate for r in rows if r.assigned_delegate}
    names = {}
    if delegate_ids:
        names = {
            u.name: u.full_name
            for u in frappe.get_all("User", filters={"name": ["in", list(delegate_ids)]}, fields=["name", "full_name"])
        }
    for r in rows:
        r["assigned_delegate_name"] = names.get(r.assigned_delegate, "") if r.assigned_delegate else ""
    return rows


@frappe.whitelist()
def bulk_assign_clients(delegate, customers):
    """Assign several clients to one delegate in a single call — the
    territory-gated "Assign Responsible Clients" flow picks a batch at
    once rather than round-tripping assign_client per row. `customers`
    is a JSON list of Customer record names. Rows are independent, same
    as the import endpoints: one bad id doesn't undo the rest of the
    batch."""
    _require_manager()
    _assert_delegate_visible(delegate)

    if not _is_plain_delegate(delegate):
        frappe.throw(_("Selected user is not a field delegate — a Delegate Manager can't be assigned clients."))

    customers = json.loads(customers) if isinstance(customers, str) else customers
    assigned, failed = [], []
    for customer in customers:
        if not frappe.db.exists("Customer", customer):
            failed.append({"customer": customer, "reason": _("Client not found.")})
            continue
        frappe.db.set_value("Customer", customer, {
            "assigned_delegate": delegate,
            "assigned_on": now_datetime(),
            "assigned_by": frappe.session.user,
        })
        assigned.append({"customer": customer})

    frappe.db.commit()
    return {
        "assigned": assigned,
        "failed": failed,
        "counts": {"assigned": len(assigned), "failed": len(failed)},
    }


@frappe.whitelist()
def _contact_id_with_phone(phone, exclude_contact=None):
    """The Contact record already using this phone, or None — mirrors
    _customer_id_with_phone, but a point of contact is one person, so
    the uniqueness key here is scoped to Contact, not Customer."""
    key = _phone_match_key(phone)
    if not key:
        return None
    like = f"%{key}"
    names = set(frappe.get_all("Contact Phone", filters={"phone": ["like", like]}, pluck="parent"))
    names.update(frappe.get_all("Contact", filters={"mobile_no": ["like", like]}, pluck="name"))
    names.discard(exclude_contact)
    return next(iter(names), None)


def _contact_phone_owner_name(contact_name):
    doc = frappe.db.get_value("Contact", contact_name, ["first_name", "last_name"], as_dict=True)
    if not doc:
        return contact_name
    return " ".join(filter(None, [doc.first_name, doc.last_name])).strip() or contact_name


def add_client_contact(customer, first_name, last_name=None, designation=None, phone=None):
    """Adds one more named point of contact (a specialist) to a client
    that may already have others — this is what makes a five-doctor
    hospital roster possible, instead of the single auto-created contact
    every client gets from create_customer/import_clients."""
    _require_manager()

    if not frappe.db.exists("Customer", customer):
        frappe.throw(_("Client not found"))
    if not (first_name or "").strip():
        return {"ok": False, "error": _("A name is required.")}

    contact = frappe.new_doc("Contact")
    contact.first_name = first_name.strip()
    contact.last_name = (last_name or "").strip()
    contact.designation = (designation or "").strip() or None
    if phone:
        cleaned, error = _validate_phone(phone)
        if error:
            return {"ok": False, "error": error}
        owner = _contact_id_with_phone(cleaned)
        if owner:
            return {"ok": False, "error": _("That phone already belongs to {0}.").format(
                _contact_phone_owner_name(owner)
            )}
        contact.append("phone_nos", {"phone": cleaned, "is_primary_mobile_no": 1})
    contact.append("links", {"link_doctype": "Customer", "link_name": customer})
    contact.insert(ignore_permissions=True)
    frappe.db.commit()
    return {"ok": True, "contact": contact.name}


@frappe.whitelist()
def update_client_contact(contact, first_name, last_name=None, designation=None, phone=None):
    """Edits an existing point of contact's name, speciality or phone."""
    _require_manager()

    if not frappe.db.exists("Contact", contact):
        return {"ok": False, "error": _("This contact no longer exists.")}
    if not (first_name or "").strip():
        return {"ok": False, "error": _("A name is required.")}

    doc = frappe.get_doc("Contact", contact)
    doc.first_name = first_name.strip()
    doc.last_name = (last_name or "").strip()
    doc.designation = (designation or "").strip() or None

    if phone:
        cleaned, error = _validate_phone(phone)
        if error:
            return {"ok": False, "error": error}
        doc.set("phone_nos", [])
        doc.append("phone_nos", {"phone": cleaned, "is_primary_mobile_no": 1})

    doc.save(ignore_permissions=True)
    frappe.db.commit()
    return {"ok": True}


@frappe.whitelist()
def delete_client_contact(contact):
    """Removes a point of contact — the specialist has left, or was a
    duplicate entry."""
    _require_manager()

    if not frappe.db.exists("Contact", contact):
        return {"ok": True}  # already gone; nothing to do
    frappe.delete_doc("Contact", contact, ignore_permissions=True)
    frappe.db.commit()
    return {"ok": True}


@frappe.whitelist()
def bulk_delete_client_contacts(contacts):
    """Deletes several points of contact at once — the Clients
    table's gear-menu Delete, acting on whichever rows are checked
    (the same selection Export uses, see selectableIdsInView in
    managers.js). `contacts` is a JSON list of Contact record names."""
    _require_manager()

    contacts = json.loads(contacts) if isinstance(contacts, str) else contacts
    deleted = 0
    for contact in contacts:
        if frappe.db.exists("Contact", contact):
            frappe.delete_doc("Contact", contact, ignore_permissions=True)
            deleted += 1
    frappe.db.commit()
    return {"ok": True, "deleted": deleted}


def _delegate_portfolio_rows(delegate):
    """One row per point-of-contact across every client this delegate
    owns — the shape of the manager's reference spreadsheet (Point of
    Contact / Organization / Speciality / Category / Province /
    District / Phone). A client with no contact on file still gets one
    row, contact fields blank, so an owned-but-empty account isn't
    invisible in the portfolio."""
    customers = frappe.get_all(
        "Customer",
        filters={"assigned_delegate": delegate},
        fields=["name", "customer_name", "customer_category", "customer_class", "province", "district"],
        order_by="customer_name asc",
    )
    rows = []
    for c in customers:
        contacts = get_customer_contacts(c.name)
        if not contacts:
            rows.append({
                "contact": None, "point_of_contact": None, "speciality": None, "phone": "",
                "customer": c.name, "organization": c.customer_name,
                "category": c.customer_category or "Uncategorized",
                "customer_class": c.customer_class or "Unclassed",
                "province": c.province, "district": c.district,
            })
            continue
        for ct in contacts:
            rows.append({
                "contact": ct.name, "point_of_contact": ct.display_name,
                "speciality": ct.designation or "", "phone": ct.phone or "",
                "customer": c.name, "organization": c.customer_name,
                "category": c.customer_category or "Uncategorized",
                "customer_class": c.customer_class or "Unclassed",
                "province": c.province, "district": c.district,
            })
    return rows


@frappe.whitelist()
def get_delegate_portfolio(delegate):
    """A delegate's full picture for the manager: territory, brands,
    and their assigned-client roster flattened to one row per
    specialist. Powers 'View Assigned Clients' from the Delegates
    table."""
    _require_manager()
    _assert_delegate_visible(delegate)

    info = get_delegate(delegate)
    return {
        "delegate": delegate,
        "full_name": info["full_name"],
        "primary_territory": info["primary_territory"],
        "secondary_territory": info["secondary_territory"],
        "brands": info["brands"],
        "rows": _delegate_portfolio_rows(delegate),
    }


@frappe.whitelist()
def get_my_clients():
    """The logged-in delegate's own assigned-client roster — the
    delegate-facing counterpart of get_delegate_portfolio, so they can
    see who they're responsible for before a visit."""
    _require_delegate()
    return {"rows": _delegate_portfolio_rows(frappe.session.user)}


# ---------- Client import/export: Assigned Delegate, Province, District ----------
# Appended to the existing CLIENT_IMPORT_COLUMNS spec rather than
# inserted, so column positions already in use don't shift under an
# existing export/re-import cycle someone has in flight.
CLIENT_IMPORT_COLUMNS.extend([
    # Matched by email — unique and unambiguous, unlike a delegate's
    # display name, which two people can easily share.
    ("Assigned Delegate", "assigned_delegate_email", False, ""),
    ("Province", "province", False, "Kigali City"),
    ("District", "district", False, "Gasabo"),
])
EXAMPLE_BY_FIELD = {field: example for _h, field, _r, example in CLIENT_IMPORT_COLUMNS}


def _validate_province_district(province, district):
    """Case-insensitive against PROVINCE_DISTRICTS — "GASABO" or
    "gasabo" is accepted the same as "Gasabo", since a manager typing
    or pasting from a spreadsheet shouldn't have a row fail over
    casing alone (see _match_choice, the same rule Org-Type/Category
    already use).

    Returns (province, district, error): the first two are the
    canonical-cased values to actually store — never the raw input's
    casing — so "GASABO" is saved as "Gasabo" regardless of how it was
    typed. error is a message string, or None when the pair is valid.
    Either may be blank; a district without its province is the only
    combination that can't be checked, so it's rejected outright."""
    if not province and not district:
        return None, None, None

    canonical_province = None
    if province:
        canonical_province = _match_choice(province, PROVINCE_DISTRICTS.keys())
        if not canonical_province:
            return None, None, _("Province must be one of: {0}.").format(", ".join(PROVINCE_DISTRICTS))

    canonical_district = None
    if district:
        if not canonical_province:
            return None, None, _("A District needs a Province to go with it.")
        canonical_district = _match_choice(district, PROVINCE_DISTRICTS[canonical_province])
        if not canonical_district:
            return None, None, _("{0} is not a district of {1}. Expected one of: {2}.").format(
                district, canonical_province, ", ".join(PROVINCE_DISTRICTS[canonical_province])
            )

    return canonical_province, canonical_district, None


def _resolve_delegate_email(email, manager_visible_check=True):
    """Returns (user_name, error). Looks a delegate up by email — the
    same uniqueness key used everywhere else a delegate is identified
    from outside the app (create_delegate's dedupe, User's own login
    identity)."""
    email = (email or "").strip().lower()
    if not email:
        return None, None
    user = frappe.db.get_value("User", {"email": email}, "name")
    if not user or "Delegate" not in frappe.get_roles(user):
        return None, _("No delegate has the email {0}.").format(email)
    if manager_visible_check:
        visible = _visible_delegates()
        if visible is not None and user not in visible:
            return None, _("{0} isn't one of your delegates.").format(email)
    return user, None


# The three delegate/geo columns share one row reader, called from both
# the update path (_apply_client_update) and the create path's second
# pass (import_clients).


def _client_geo_and_delegate_from_row(row, mapping, current_customer=None):
    """Reads Assigned Delegate / Province / District from an import row.
    Returns (updates_dict, error). updates_dict only contains keys for
    non-blank cells — blank still means "leave unchanged", consistent
    with every other optional column."""
    updates = {}

    email = _cell(row, mapping, "assigned_delegate_email")
    if email:
        delegate, error = _resolve_delegate_email(email)
        if error:
            return None, error
        updates["assigned_delegate"] = delegate
        updates["assigned_on"] = now_datetime()
        updates["assigned_by"] = frappe.session.user

    province = _cell(row, mapping, "province")
    district = _cell(row, mapping, "district")
    if province or district:
        province, district, error = _validate_province_district(province or None, district or None)
        if error:
            return None, error
        if province:
            updates["province"] = province
        if district:
            updates["district"] = district

    return updates, None


# ---------- Points-of-contact import/export ("Specialists") ----------
# A separate sheet from the client one, because the relationship is
# one-to-many: a single hospital contributes several rows here, one per
# named specialist, matched back to their organization by Client ID.

CONTACT_IMPORT_COLUMNS = [
    # (header, field, required, example)
    ("Client ID", "client_id", False, "MVP-00001"),
    # Read at import time only as a fallback when Client ID is blank —
    # matched by exact name against an enabled client, and only if that
    # match is unambiguous. Always written back out on export, mirroring
    # the manager's own reference spreadsheet.
    ("Organization", "organization", False, "King Faisal Hospital"),
    ("Point of Contact", "point_of_contact", True, "Dufatanye Darius"),
    ("Speciality", "speciality", False, "Cardiologist"),
    ("Phone", "phone", False, "+250790779916"),
]


@frappe.whitelist()
def list_contact_columns():
    _require_manager()
    return [{"field": f, "label": h, "recommended": f in ("client_id", "point_of_contact")}
            for h, f, _r, _e in CONTACT_IMPORT_COLUMNS]


def _split_contact_name(full_name):
    parts = (full_name or "").strip().split(" ", 1)
    return parts[0], (parts[1] if len(parts) > 1 else "")


def _find_client_for_contact_row(client_id, organization):
    """Returns (customer_name, error). Client ID first (unambiguous by
    construction); Organization name only as a fallback, and only when
    it matches exactly one enabled client — a typo'd or shared name
    fails the row rather than silently picking the wrong hospital."""
    if client_id:
        customer = frappe.db.get_value("Customer", {"medvisitpro_client_id": client_id}, "name")
        if not customer:
            return None, _("No client has the ID {0}.").format(client_id)
        return customer, None

    if not organization:
        return None, _("Give either a Client ID or an Organization name.")

    matches = frappe.get_all(
        "Customer",
        filters={"customer_name": organization, "is_medvisitpro_enabled": 1},
        pluck="name",
    )
    if not matches:
        return None, _(
            "No client named '{0}' was found. Add the client first, or use its Client ID."
        ).format(organization)
    if len(matches) > 1:
        return None, _(
            "{0} matches more than one client — use its Client ID instead of the name."
        ).format(organization)
    return matches[0], None


@frappe.whitelist()
def import_client_contacts(filename, content):
    """Bulk add/update points of contact from a spreadsheet shaped like
    the manager's own roster sheet: one row per specialist. A row whose
    Point of Contact name already exists on the matched client (case-
    insensitive) updates that contact's speciality/phone; otherwise a
    new one is added — so re-uploading an edited export doesn't create
    duplicate people the way a bare "always append" would."""
    _require_manager()

    import base64
    try:
        raw = base64.b64decode(content)
    except Exception:
        frappe.throw(_("The upload was corrupted in transit. Try again."), title=_("Bad Upload"))

    rows = _parse_upload(filename, raw)
    rows = [r for r in rows if any(str(c or "").strip() for c in r)]
    if len(rows) < 2:
        frappe.throw(_("That file has a header row but no contacts in it."), title=_("Nothing To Import"))

    seen = {}
    for idx, cell in enumerate(rows[0]):
        seen.setdefault(_normalise_header(cell), idx)
    mapping = {}
    for header, field, _required, _example in CONTACT_IMPORT_COLUMNS:
        idx = seen.get(_normalise_header(header))
        if idx is not None:
            mapping[field] = idx
    if "point_of_contact" not in mapping:
        frappe.throw(
            _("The file needs a 'Point of Contact' column. Download the template and use its header row."),
            title=_("Wrong Columns"),
        )

    created, updated, failed = [], [], []
    for offset, row in enumerate(rows[1:], start=2):
        name = _cell(row, mapping, "point_of_contact")
        if not name:
            failed.append({"row": offset, "column": "Point of Contact", "reason": _("Name is empty.")})
            continue

        client_id = _cell(row, mapping, "client_id")
        organization = _cell(row, mapping, "organization")
        customer, error = _find_client_for_contact_row(client_id, organization)
        if error:
            failed.append({"row": offset, "name": name, "column": "Client ID / Organization", "reason": error})
            continue

        speciality = _cell(row, mapping, "speciality")
        raw_phone = _cell(row, mapping, "phone")
        phone = None
        if raw_phone:
            phone, phone_error = _validate_phone(raw_phone)
            if phone_error:
                failed.append({"row": offset, "name": name, "column": "Phone", "reason": phone_error})
                continue

        existing = [
            c for c in get_customer_contacts(customer)
            if c.display_name.strip().lower() == name.strip().lower()
        ]

        savepoint = f"contact_{offset}"
        frappe.db.savepoint(savepoint)
        try:
            if existing:
                doc = frappe.get_doc("Contact", existing[0].name)
                if speciality:
                    doc.designation = speciality
                if phone:
                    doc.set("phone_nos", [])
                    doc.append("phone_nos", {"phone": phone, "is_primary_mobile_no": 1})
                doc.save(ignore_permissions=True)
                updated.append({"row": offset, "name": name, "customer": customer})
            else:
                first, last = _split_contact_name(name)
                doc = frappe.new_doc("Contact")
                doc.first_name = first
                doc.last_name = last
                doc.designation = speciality or None
                if phone:
                    doc.append("phone_nos", {"phone": phone, "is_primary_mobile_no": 1})
                doc.append("links", {"link_doctype": "Customer", "link_name": customer})
                doc.insert(ignore_permissions=True)
                created.append({"row": offset, "name": name, "customer": customer})
        except Exception as e:
            frappe.db.rollback(save_point=savepoint)
            failed.append({"row": offset, "name": name, "reason": str(e)})

    frappe.db.commit()
    return {
        "created": created, "updated": updated, "failed": failed,
        "counts": {
            "created": len(created), "updated": len(updated), "failed": len(failed),
            "total": len(rows) - 1,
        },
    }


def _contact_export_rows(customer_names=None, columns=None, delegate=None):
    """`delegate`, when given, scopes the export to one delegate's own
    clients — every specialist across every organization they own, not
    just one. Brand-checked the same as everywhere else a manager
    reaches into a specific delegate's data."""
    spec = CONTACT_IMPORT_COLUMNS
    if columns is not None:
        wanted = set(columns)
        narrowed = [c for c in CONTACT_IMPORT_COLUMNS if c[1] in wanted]
        if narrowed:
            spec = narrowed

    rows = [[c[0] for c in spec]]
    filters = {"is_medvisitpro_enabled": 1}
    if customer_names is not None:
        filters["name"] = ["in", customer_names]
    if delegate:
        _assert_delegate_visible(delegate)
        filters["assigned_delegate"] = delegate

    customers = frappe.get_all(
        "Customer", filters=filters, fields=["name", "medvisitpro_client_id", "customer_name"],
        order_by="customer_name asc", limit_page_length=0,
    )
    for c in customers:
        for ct in get_customer_contacts(c.name):
            values = {
                "client_id": c.medvisitpro_client_id or "",
                "organization": c.customer_name or "",
                "point_of_contact": ct.display_name,
                "speciality": ct.designation or "",
                "phone": ct.phone or "",
            }
            rows.append([values[field] for _h, field, _r, _e in spec])
    return rows


@frappe.whitelist(methods=["GET"])
def download_contact_template(fmt="xlsx", mode="template", customers=None, columns=None, delegate=None):
    """The Specialists counterpart to download_client_template — same
    template/export split, same customers=/columns= scoping, plus
    delegate= to pull one delegate's own roster instead of everyone's."""
    _require_manager()

    exporting = mode == "export"
    customer_names = None
    if exporting and customers:
        customer_names = [c.strip() for c in customers.split(",") if c.strip()] or None

    column_fields = None
    if exporting and columns:
        column_fields = [c.strip() for c in columns.split(",") if c.strip()] or None

    delegate = delegate.strip() if exporting and delegate else None

    if exporting:
        rows = _contact_export_rows(customer_names, column_fields, delegate)
        stem = "medvisitpro_contacts"
        if delegate:
            stem += "_" + frappe.scrub(frappe.db.get_value("User", delegate, "full_name") or delegate)
        elif customer_names:
            stem += "_selected"
    else:
        rows = [[c[0] for c in CONTACT_IMPORT_COLUMNS], [c[3] for c in CONTACT_IMPORT_COLUMNS]]
        stem = "medvisitpro_contact_template"

    if fmt == "csv":
        import csv
        import io

        buf = io.StringIO()
        csv.writer(buf).writerows(rows)
        content = buf.getvalue()
        filename = f"{stem}.csv"
    else:
        from frappe.utils.xlsxutils import make_xlsx

        xlsx = make_xlsx(rows, "Contacts")
        content = xlsx.getvalue()
        filename = f"{stem}.xlsx"

    frappe.response["type"] = "download"
    frappe.response["filename"] = filename
    frappe.response["filecontent"] = content
    frappe.response["content_type"] = (
        "text/csv" if fmt == "csv" else
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )


# ============================================================
# Unified Roster import/export — Organization + Point of Contact
# in one row, matching the manager's own reference spreadsheet
# (Point of Contact / Organization / Org-Type / Speciality /
# Category / Province / District / Phone). Creates or updates both
# the Customer and its Contact from a single row, replacing the
# two-step Client-import-then-Contact-import process above with one
# shorter pass.
# ============================================================

ROSTER_IMPORT_COLUMNS = [
    # (header, field, required, example)
    ("Client ID", "client_id", False, ""),
    ("Organization", "organization", True, "King Faisal Hospital"),
    ("Org-Type", "customer_category", False, "Hospital"),
    ("Point of Contact", "point_of_contact", True, "Dufatanye Darius"),
    ("Speciality", "speciality", False, "Cardiologist"),
    ("Category", "customer_class", False, "Supercore"),
    ("Province", "province", False, "Kigali City"),
    ("District", "district", False, "Gasabo"),
    ("Phone", "phone", True, "790779916"),
    ("Assigned Delegate", "assigned_delegate_email", False, ""),
]
ROSTER_EXAMPLE_BY_FIELD = {field: example for _h, field, _r, example in ROSTER_IMPORT_COLUMNS}


def _normalise_roster_phone(value):
    """The reference spreadsheet writes personal numbers as 9 digits
    with no leading 0 or country code (e.g. 790779916) — one short of
    _validate_phone's MIN_PHONE_DIGITS. A 9-digit roster phone is
    treated as a local subscriber number and given Rwanda's country
    code before validation, matching the +250 form used everywhere
    else, rather than loosening the check for every other import."""
    raw = str(value or "").strip()
    if raw.startswith("+"):
        return raw
    _cleaned, digits = _clean_phone(raw)
    if len(digits) == 9:
        return "+250" + digits
    return raw


def _find_or_create_roster_customer(client_id, organization, org_cache):
    """Returns (customer_name, created, error) for one roster row's
    organization. Client ID wins when given. Otherwise matched by
    exact case-insensitive Organization name — first against
    customers already confirmed earlier in *this* import (org_cache),
    since the same hospital repeats across many rows, then against the
    database. No match creates a new, minimal Customer; its Client ID
    is assigned automatically by assign_client_id (customer_hooks.py).

    Does not write to org_cache itself — a row that fails validation
    later and gets rolled back must not leave a dangling cache entry
    pointing at a customer that no longer exists. The caller adds to
    the cache only once a row has fully succeeded."""
    if client_id:
        customer = frappe.db.get_value("Customer", {"medvisitpro_client_id": client_id}, "name")
        if not customer:
            return None, False, _("No client has the ID {0}.").format(client_id)
        return customer, False, None

    if not organization:
        return None, False, _("Give either a Client ID or an Organization name.")

    key = organization.strip().lower()
    if key in org_cache:
        return org_cache[key], False, None

    matches = frappe.get_all(
        "Customer",
        filters={"customer_name": organization, "is_medvisitpro_enabled": 1},
        pluck="name",
    )
    if len(matches) > 1:
        return None, False, _(
            "{0} matches more than one client — use its Client ID instead of the name."
        ).format(organization)
    if matches:
        return matches[0], False, None

    customer = frappe.new_doc("Customer")
    customer.customer_name = organization
    customer.customer_type = "Company"
    customer.is_medvisitpro_enabled = 1
    customer.insert(ignore_permissions=True)
    return customer.name, True, None


def _apply_roster_org_fields(customer, row, mapping):
    """Blank cell = leave unchanged, same convention as every other
    import in this file. Validates everything before writing anything,
    so a bad cell doesn't leave the Customer half-updated. Returns an
    error string, or None."""
    updates = {}

    category = _cell(row, mapping, "customer_category")
    if category:
        matched = _match_choice(category, VALID_CATEGORIES)
        if not matched:
            return _("Org-Type must be one of: {0}.").format(", ".join(VALID_CATEGORIES))
        updates["customer_category"] = matched

    klass = _cell(row, mapping, "customer_class")
    if klass:
        matched = _match_choice(klass, VALID_CLASSES)
        if not matched:
            return _("Category must be one of: {0}.").format(", ".join(VALID_CLASSES))
        updates["customer_class"] = matched
        # set_expected_visits_from_class (customer_hooks.py) derives
        # this on doc.save(), but this whole function writes via
        # frappe.db.set_value further down — a raw DB write that never
        # goes through Customer.validate, so that hook never fires for
        # an import. Computed here directly instead, from the same
        # mapping, so the two can't drift apart.
        updates["expected_visits_per_month"] = EXPECTED_VISITS_BY_CLASS.get(matched, 0)

    province = _cell(row, mapping, "province")
    district = _cell(row, mapping, "district")
    if province or district:
        province, district, error = _validate_province_district(province or None, district or None)
        if error:
            return error
        if province:
            updates["province"] = province
        if district:
            updates["district"] = district

    email = _cell(row, mapping, "assigned_delegate_email")
    if email:
        delegate, error = _resolve_delegate_email(email)
        if error:
            return error
        updates["assigned_delegate"] = delegate
        updates["assigned_on"] = now_datetime()
        updates["assigned_by"] = frappe.session.user

    if updates:
        frappe.db.set_value("Customer", customer, updates)
    return None


def _find_or_update_roster_contact(customer, name, speciality, phone, email=None):
    """Matches an existing point of contact on `customer` by name
    (case-insensitive) — the same rule import_client_contacts uses —
    so a hospital's specialists don't duplicate on re-import. Returns
    (created, error).

    `email` is optional and unused by import_roster/ROSTER_IMPORT_COLUMNS
    (the reference spreadsheet this shape is modelled on has no email
    column) — it exists for save_client_record, where the Add Client
    modal collects one directly."""
    existing = [
        c for c in get_customer_contacts(customer)
        if c.display_name.strip().lower() == name.strip().lower()
    ]
    if existing:
        doc = frappe.get_doc("Contact", existing[0].name)
        if speciality:
            doc.designation = speciality
        if phone:
            doc.set("phone_nos", [])
            doc.append("phone_nos", {"phone": phone, "is_primary_mobile_no": 1})
        if email:
            doc.set("email_ids", [])
            doc.append("email_ids", {"email_id": email, "is_primary": 1})
        doc.save(ignore_permissions=True)
        return False, None

    first, last = _split_contact_name(name)
    doc = frappe.new_doc("Contact")
    doc.first_name = first
    doc.last_name = last
    doc.designation = speciality or None
    if phone:
        doc.append("phone_nos", {"phone": phone, "is_primary_mobile_no": 1})
    if email:
        doc.append("email_ids", {"email_id": email, "is_primary": 1})
    doc.append("links", {"link_doctype": "Customer", "link_name": customer})
    doc.insert(ignore_permissions=True)
    return True, None


def _map_roster_columns(header_row):
    seen = {}
    for idx, cell in enumerate(header_row):
        seen.setdefault(_normalise_header(cell), idx)
    mapping = {}
    for header, field, _required, _example in ROSTER_IMPORT_COLUMNS:
        idx = seen.get(_normalise_header(header))
        if idx is not None:
            mapping[field] = idx
    if "point_of_contact" not in mapping or "organization" not in mapping:
        frappe.throw(
            _(
                "The file needs 'Organization' and 'Point of Contact' columns. "
                "Download the template and use its header row."
            ),
            title=_("Wrong Columns"),
        )
    return mapping


@frappe.whitelist()
def import_roster(filename, content):
    """Bulk add/update the manager's roster in one pass: one row per
    point of contact, creating or updating both the Organization
    (Customer) and the specialist (Contact) together."""
    _require_manager()

    import base64
    try:
        raw = base64.b64decode(content)
    except Exception:
        frappe.throw(_("The upload was corrupted in transit. Try again."), title=_("Bad Upload"))

    rows = _parse_upload(filename, raw)
    rows = [r for r in rows if any(str(c or "").strip() for c in r)]
    if len(rows) < 2:
        frappe.throw(_("That file has a header row but no rows in it."), title=_("Nothing To Import"))

    mapping = _map_roster_columns(rows[0])

    # Shaped like import_clients/import_client_contacts' return value
    # (created/updated/skipped/failed + counts) on purpose — the
    # manager's Import/Export modal renders all three imports through
    # the same renderImportResult(), so a roster row just needs to land
    # in the bucket that means the same thing there. "created" here
    # means a new specialist was added (regardless of whether their
    # organization was also new — organizations_created stays a side
    # note on that row's entry); "skipped" never happens for a roster
    # row — every row either writes or fails — but the key is kept so
    # the shared renderer doesn't need a special case.
    created, updated, failed = [], [], []
    org_cache = {}

    for offset, row in enumerate(rows[1:], start=2):
        name = _cell(row, mapping, "point_of_contact")
        organization = _cell(row, mapping, "organization")
        if (
            name == ROSTER_EXAMPLE_BY_FIELD["point_of_contact"]
            and organization == ROSTER_EXAMPLE_BY_FIELD["organization"]
        ):
            continue  # the template's worked example row

        if not name:
            failed.append({"row": offset, "column": "Point of Contact", "reason": _("Name is empty.")})
            continue

        client_id = _cell(row, mapping, "client_id")

        savepoint = f"roster_{offset}"
        frappe.db.savepoint(savepoint)
        try:
            customer, _org_created, error = _find_or_create_roster_customer(client_id, organization, org_cache)
            if error:
                failed.append({"row": offset, "name": name, "column": "Client ID / Organization", "reason": error})
                continue

            error = _apply_roster_org_fields(customer, row, mapping)
            if error:
                frappe.db.rollback(save_point=savepoint)
                failed.append({
                    "row": offset, "name": name,
                    "column": "Org-Type / Category / Province / District / Assigned Delegate",
                    "reason": error,
                })
                continue

            speciality = _cell(row, mapping, "speciality")
            raw_phone = _cell(row, mapping, "phone")
            phone = None
            if raw_phone:
                phone, phone_error = _validate_phone(_normalise_roster_phone(raw_phone))
                if phone_error:
                    frappe.db.rollback(save_point=savepoint)
                    failed.append({"row": offset, "name": name, "column": "Phone", "reason": phone_error})
                    continue
                owner = _contact_id_with_phone(phone)
                existing_here = [
                    c for c in get_customer_contacts(customer)
                    if c.display_name.strip().lower() == name.strip().lower()
                ]
                already_theirs = existing_here and owner == existing_here[0].name
                if owner and not already_theirs:
                    frappe.db.rollback(save_point=savepoint)
                    failed.append({
                        "row": offset, "name": name, "column": "Phone",
                        "reason": _("That phone already belongs to {0}.").format(_contact_phone_owner_name(owner)),
                    })
                    continue

            contact_created, error = _find_or_update_roster_contact(customer, name, speciality, phone)
            if error:
                frappe.db.rollback(save_point=savepoint)
                failed.append({"row": offset, "name": name, "reason": error})
                continue
        except Exception as e:
            frappe.db.rollback(save_point=savepoint)
            failed.append({"row": offset, "name": name, "reason": str(e)})
            continue

        if organization:
            org_cache[organization.strip().lower()] = customer
        if contact_created:
            created.append({"row": offset, "name": name, "customer": customer})
        else:
            updated.append({
                "row": offset, "name": name, "customer": customer,
                "changed": ["speciality/phone"] if (speciality or raw_phone) else [],
            })

    frappe.db.commit()
    return {
        "created": created,
        "updated": updated,
        "skipped": [],
        "failed": failed,
        "counts": {
            "created": len(created),
            "updated": len(updated),
            "skipped": 0,
            "failed": len(failed),
            "total": len(rows) - 1,
        },
    }


def _roster_export_rows(customer_names=None, delegate=None, columns=None, contact_names=None):
    """One row per point of contact, in ROSTER_IMPORT_COLUMNS order —
    the same shape _delegate_portfolio_rows already builds for the
    in-app portfolio view, exposed here as a downloadable sheet.
    `delegate`, when given, scopes the export to one delegate's own
    responsible-client list. `columns`, when given, restricts which
    fields are included — same convention as _export_rows/
    _contact_export_rows. `contact_names`, when given, narrows to
    specific points of contact (the Clients table's row selection is
    Contact-scoped now, not Customer-scoped — see list_client_contacts)
    rather than every contact belonging to their organization."""
    spec = ROSTER_IMPORT_COLUMNS
    if columns is not None:
        wanted = set(columns)
        narrowed = [c for c in ROSTER_IMPORT_COLUMNS if c[1] in wanted]
        if narrowed:
            spec = narrowed

    filters = {"is_medvisitpro_enabled": 1}
    if customer_names is not None:
        filters["name"] = ["in", customer_names]
    if delegate:
        _assert_delegate_visible(delegate)
        filters["assigned_delegate"] = delegate

    customers = frappe.get_all(
        "Customer",
        filters=filters,
        fields=[
            "name", "medvisitpro_client_id", "customer_name", "customer_category",
            "customer_class", "province", "district", "assigned_delegate",
        ],
        order_by="customer_name asc",
        limit_page_length=0,
    )

    contact_filter = set(contact_names) if contact_names is not None else None
    rows = [[c[0] for c in spec]]
    for c in customers:
        assigned_email = (
            frappe.db.get_value("User", c.assigned_delegate, "email") if c.assigned_delegate else ""
        )
        contacts = get_customer_contacts(c.name) or [None]
        for ct in contacts:
            if contact_filter is not None and (not ct or ct.name not in contact_filter):
                continue
            values = {
                "client_id": c.medvisitpro_client_id or "",
                "organization": c.customer_name or "",
                "customer_category": c.customer_category or "",
                "point_of_contact": ct.display_name if ct else "",
                "speciality": (ct.designation or "") if ct else "",
                "customer_class": c.customer_class or "",
                "province": c.province or "",
                "district": c.district or "",
                "phone": (ct.phone or "") if ct else "",
                "assigned_delegate_email": assigned_email,
            }
            rows.append([values[field] for _h, field, _r, _e in spec])
    return rows


@frappe.whitelist()
def list_roster_columns():
    _require_manager()
    return [
        {"field": f, "label": h, "recommended": f in ("client_id", "organization", "point_of_contact")}
        for h, f, _r, _e in ROSTER_IMPORT_COLUMNS
    ]


@frappe.whitelist(methods=["GET"])
def download_roster_template(fmt="xlsx", mode="template", customers=None, delegate=None, columns=None, contacts=None):
    """The combined Client + Point of Contact counterpart to
    download_client_template / download_contact_template — same
    template/export split and columns= scoping, plus delegate= to pull
    one delegate's own responsible-client roster instead of everyone's.
    `contacts=`, when given, narrows to specific points of contact —
    the Clients table's row selection (see list_client_contacts)."""
    _require_manager()

    exporting = mode == "export"
    customer_names = None
    if exporting and customers:
        customer_names = [c.strip() for c in customers.split(",") if c.strip()] or None

    contact_names = None
    if exporting and contacts:
        contact_names = [c.strip() for c in contacts.split(",") if c.strip()] or None

    column_fields = None
    if exporting and columns:
        column_fields = [c.strip() for c in columns.split(",") if c.strip()] or None

    delegate = delegate.strip() if exporting and delegate else None

    if exporting:
        rows = _roster_export_rows(customer_names, delegate, column_fields, contact_names)
        stem = "medvisitpro_roster"
        if delegate:
            stem += "_" + frappe.scrub(frappe.db.get_value("User", delegate, "full_name") or delegate)
        elif contact_names or customer_names:
            stem += "_selected"
    else:
        rows = [[c[0] for c in ROSTER_IMPORT_COLUMNS], [c[3] for c in ROSTER_IMPORT_COLUMNS]]
        stem = "medvisitpro_roster_template"

    if fmt == "csv":
        import csv
        import io

        buf = io.StringIO()
        csv.writer(buf).writerows(rows)
        content = buf.getvalue()
        filename = f"{stem}.csv"
    else:
        from frappe.utils.xlsxutils import make_xlsx

        xlsx = make_xlsx(rows, "Roster")
        content = xlsx.getvalue()
        filename = f"{stem}.xlsx"

    frappe.response["type"] = "download"
    frappe.response["filename"] = filename
    frappe.response["filecontent"] = content
    frappe.response["content_type"] = (
        "text/csv" if fmt == "csv" else
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
