import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate


class VisitAssignment(Document):
    def validate(self):
        self.set_week_start_date()
        self.enforce_customer_enabled()
        self.enforce_future_date_on_create()

    def enforce_future_date_on_create(self):
        """Only checked on creation, not on later saves — an existing
        Pending assignment is SUPPOSED to be allowed to age into the
        past, since that's exactly how we detect a Missed visit."""
        if not self.is_new():
            return
        if self.scheduled_date and getdate(self.scheduled_date) < getdate(frappe.utils.nowdate()):
            frappe.throw(
                _("Cannot create a visit assignment for a date in the past."),
                title=_("Invalid Date")
            )

    def enforce_customer_enabled(self):
        if not frappe.db.get_value("Customer", self.customer, "is_medvisitpro_enabled"):
            frappe.throw(
                _("This customer is not enabled for MedvisitPro. "
                  "Enable it on the Customer record first."),
                title=_("Customer Not Enabled")
            )

    def set_week_start_date(self):
        """Always store the Monday of the week that scheduled_date
        falls in, regardless of which day of the week was picked.
        Makes weekly report queries a simple equality filter."""
        if not self.scheduled_date:
            return

        date = getdate(self.scheduled_date)
        # Monday = 0 ... Sunday = 6
        monday = frappe.utils.add_days(date, -date.weekday())
        self.week_start_date = monday
