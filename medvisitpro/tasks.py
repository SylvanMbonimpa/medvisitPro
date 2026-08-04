import frappe
from frappe.utils import nowdate


def mark_missed_visits():
    """Runs daily (see hooks.py scheduler_events). Any Visit
    Assignment still Pending after its scheduled_date has passed
    gets marked Missed. Ad-hoc visits are naturally excluded — they
    only ever exist for the day they're created and completed on the
    spot, so this is really scoped to Scheduled assignments in
    practice, but we don't filter on visit_type here since a Missed
    Ad-hoc doesn't make logical sense to begin with (it wouldn't
    exist as Pending past today)."""
    frappe.db.sql(
        """
        UPDATE `tabVisit Assignment`
        SET status = 'Missed'
        WHERE status = 'Pending'
          AND scheduled_date < %s
        """,
        (nowdate(),),
    )
    frappe.db.commit()
