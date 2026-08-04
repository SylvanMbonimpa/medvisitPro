import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_days, getdate, now_datetime, nowdate

# A Weekly Visit Plan is the delegate's *proposal* for a week. Nothing
# in it is actionable until a Delegate Manager approves it: only an
# approved line materialises into a real Visit Assignment. That
# separation is deliberate — it keeps every existing query (the
# delegate dashboard, team analytics, the missed-visit sweep) working
# on Visit Assignment alone, with no notion of "unapproved" to filter
# out.
#
# The manager can decide line by line or accept the whole week in one
# action, so a plan can end up Partially Approved: some lines live,
# some sent back with a comment for the delegate to fix and resubmit.
#
# Ad-hoc visits live here too. When a delegate finds a reason mid-week
# to see a client the plan never covered, that request is appended to
# this same plan as an Ad-hoc line and the plan drops back to Pending
# Approval — so the manager has one place per delegate per week to
# look, and the delegate cannot check in until it clears.

EDITABLE_STATUSES = ("Draft", "Rejected", "Partially Approved")


class WeeklyVisitPlan(Document):
    def validate(self):
        self.normalise_week_start_date()
        self.enforce_one_plan_per_week()
        self.enforce_lines_within_week()
        self.enforce_customers_enabled()
        self.enforce_adhoc_has_reason()
        self.enforce_contacts_belong_to_customer()
        self.enforce_no_duplicate_lines()

    def normalise_week_start_date(self):
        """Store the Monday of whichever week was picked, matching how
        Visit Assignment.week_start_date is normalised — the two are
        compared directly when pulling a delegate's week."""
        if not self.week_start_date:
            return
        date = getdate(self.week_start_date)
        self.week_start_date = add_days(date, -date.weekday())

    def enforce_one_plan_per_week(self):
        """One plan per delegate per week. Without this a delegate
        could submit two competing plans for the same week and the
        manager would have no way to tell which one is current."""
        if not (self.delegate and self.week_start_date):
            return
        existing = frappe.db.exists(
            "Weekly Visit Plan",
            {
                "delegate": self.delegate,
                "week_start_date": self.week_start_date,
                "name": ["!=", self.name or ""],
            },
        )
        if existing:
            frappe.throw(
                _("{0} already has a plan ({1}) for the week of {2}.").format(
                    self.delegate, existing, self.week_start_date
                ),
                title=_("Duplicate Plan"),
            )

    def enforce_lines_within_week(self):
        """Every planned visit must fall inside the week the plan is
        for — otherwise an approved line would create an assignment
        whose own week_start_date points at a different week, and it
        would silently vanish from this plan's reporting."""
        if not self.week_start_date:
            return
        week_start = getdate(self.week_start_date)
        week_end = add_days(week_start, 6)

        for line in self.planned_visits:
            if not line.scheduled_date:
                continue
            date = getdate(line.scheduled_date)
            if date < week_start or date > week_end:
                frappe.throw(
                    _("Row {0}: {1} is outside the plan week ({2} to {3}).").format(
                        line.idx, date, week_start, week_end
                    ),
                    title=_("Date Outside Week"),
                )

    def enforce_customers_enabled(self):
        """Mirrors the same check on Visit Assignment, but applied at
        planning time so the delegate finds out now rather than having
        the manager's approval blow up later."""
        for line in self.planned_visits:
            if not line.customer:
                continue
            if not frappe.db.get_value("Customer", line.customer, "is_medvisitpro_enabled"):
                frappe.throw(
                    _("Row {0}: {1} is not enabled for MedvisitPro.").format(
                        line.idx, line.customer
                    ),
                    title=_("Customer Not Enabled"),
                )

    def enforce_adhoc_has_reason(self):
        """An Ad-hoc line is approved purely on its justification, so
        it cannot exist without one."""
        for line in self.planned_visits:
            if line.visit_type == "Ad-hoc" and not (line.reason or "").strip():
                frappe.throw(
                    _("Row {0}: an ad-hoc visit needs a reason.").format(line.idx),
                    title=_("Reason Required"),
                )

    def enforce_contacts_belong_to_customer(self):
        """A point of contact has to actually work at the client being
        visited. The picker already filters by client, so this catches
        a stale selection left behind when the client was changed."""
        for line in self.planned_visits:
            if not (line.contact_person and line.customer):
                continue
            linked = frappe.db.exists(
                "Dynamic Link",
                {
                    "parent": line.contact_person,
                    "parenttype": "Contact",
                    "link_doctype": "Customer",
                    "link_name": line.customer,
                },
            )
            if not linked:
                frappe.throw(
                    _("Row {0}: {1} is not a contact of {2}.").format(
                        line.idx, line.contact_person, line.customer
                    ),
                    title=_("Wrong Contact"),
                )

    def enforce_no_duplicate_lines(self):
        """Same customer twice on the same day is almost always a
        double-entry slip rather than a real intention. Rejected lines
        are skipped — they're history, and they shouldn't block the
        delegate from re-proposing the visit with a better case."""
        seen = {}
        for line in self.planned_visits:
            if not (line.customer and line.scheduled_date):
                continue
            if line.approval_status == "Rejected":
                continue
            key = (line.customer, str(getdate(line.scheduled_date)))
            if key in seen:
                frappe.throw(
                    _("Row {0} repeats {1} on {2}, already planned in row {3}.").format(
                        line.idx, line.customer, line.scheduled_date, seen[key]
                    ),
                    title=_("Duplicate Visit"),
                )
            seen[key] = line.idx

    # ------------------------------------------------------------
    # Delegate side
    # ------------------------------------------------------------

    def submit_for_approval(self):
        """Draft (or a plan sent back for fixes) -> Pending Approval.

        Only lines still awaiting a decision are put up for review;
        lines the manager already approved on an earlier pass keep
        their Visit Assignment and are left alone."""
        if self.status not in EDITABLE_STATUSES:
            frappe.throw(
                _("A plan that is {0} cannot be submitted again.").format(_(self.status)),
                title=_("Not Submittable"),
            )

        reviewable = [ln for ln in self.planned_visits if ln.approval_status != "Approved"]
        if not reviewable:
            frappe.throw(
                _("Add at least one visit before sending this plan for approval."),
                title=_("Empty Plan"),
            )

        today = getdate(nowdate())
        for line in reviewable:
            if getdate(line.scheduled_date) < today:
                frappe.throw(
                    _("Row {0}: {1} is in the past. Move it to a future day before submitting.").format(
                        line.idx, line.scheduled_date
                    ),
                    title=_("Past Date"),
                )
            # A resubmitted line starts its review clean — the previous
            # rejection comment would otherwise hang around and read as
            # a fresh decision.
            line.approval_status = "Pending"
            line.manager_comment = None

        self.status = "Pending Approval"
        self.submitted_on = now_datetime()
        self.manager_comment = None
        self.save(ignore_permissions=True)

    def add_adhoc_request(self, customer, reason, contact_person=None):
        """Delegate hit a reason mid-week to see a client the plan
        didn't cover. It goes onto this same plan as an Ad-hoc line
        and puts the plan back in front of the manager.

        Unlike submit_for_approval this works whatever state the plan
        is in — an already-Approved week must still be able to take a
        new request, and that's precisely the common case."""
        if not (reason or "").strip():
            frappe.throw(_("Give a reason for this visit."), title=_("Reason Required"))

        line = self.append("planned_visits", {
            "customer": customer,
            "contact_person": contact_person,
            "scheduled_date": nowdate(),
            "scheduled_time": frappe.utils.nowtime(),
            "visit_type": "Ad-hoc",
            "reason": reason.strip(),
            "approval_status": "Pending",
        })

        self.status = "Pending Approval"
        self.submitted_on = now_datetime()
        self.save(ignore_permissions=True)

        return line

    # ------------------------------------------------------------
    # Manager side
    # ------------------------------------------------------------

    def decide_line(self, row_name, decision, comment=None):
        """Approve or reject a single planned visit."""
        self._assert_under_review()

        line = self._line(row_name)
        if line.approval_status == "Approved":
            frappe.throw(_("This visit is already approved."), title=_("Already Decided"))

        if decision == "Approved":
            self._approve_line(line)
        elif decision == "Rejected":
            if not (comment or "").strip():
                frappe.throw(
                    _("Give the delegate a reason when rejecting a visit."),
                    title=_("Comment Required"),
                )
            line.approval_status = "Rejected"
            line.manager_comment = comment.strip()
        else:
            frappe.throw(_("Unknown decision: {0}").format(decision))

        self._finalise_review()

    def approve_all(self):
        """Accept the whole week in one action — every line still
        pending becomes a live assignment."""
        self._assert_under_review()

        pending = [ln for ln in self.planned_visits if ln.approval_status == "Pending"]
        if not pending:
            frappe.throw(_("Every visit in this plan has already been decided."))

        for line in pending:
            self._approve_line(line)

        self._finalise_review()

    def reject_all(self, comment):
        """Send the whole week back. Lines approved on an earlier pass
        keep their assignments — only pending ones are rejected."""
        self._assert_under_review()

        if not (comment or "").strip():
            frappe.throw(
                _("Give the delegate a reason when rejecting a plan."),
                title=_("Comment Required"),
            )

        pending = [ln for ln in self.planned_visits if ln.approval_status == "Pending"]
        if not pending:
            frappe.throw(_("Every visit in this plan has already been decided."))

        for line in pending:
            line.approval_status = "Rejected"
            line.manager_comment = comment.strip()

        self.manager_comment = comment.strip()
        self._finalise_review()

    # ------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------

    def _assert_under_review(self):
        if self.status != "Pending Approval":
            frappe.throw(
                _("This plan is {0}, not awaiting approval.").format(_(self.status)),
                title=_("Not Under Review"),
            )

    def _line(self, row_name):
        for line in self.planned_visits:
            if line.name == row_name:
                return line
        frappe.throw(_("That visit is no longer part of this plan."), frappe.DoesNotExistError)

    def _approve_line(self, line):
        """Turn an approved plan line into the real thing. This is the
        only place a plan crosses over into Visit Assignment."""
        if getdate(line.scheduled_date) < getdate(nowdate()):
            frappe.throw(
                _("{0} on {1} is already in the past. Send it back so the delegate can reschedule.").format(
                    line.customer, line.scheduled_date
                ),
                title=_("Past Date"),
            )

        assignment = frappe.new_doc("Visit Assignment")
        assignment.delegate = self.delegate
        assignment.customer = line.customer
        assignment.contact_person = line.contact_person
        assignment.scheduled_date = line.scheduled_date
        assignment.scheduled_time = line.scheduled_time
        assignment.status = "Pending"
        assignment.visit_type = line.visit_type or "Scheduled"
        assignment.assigned_by = frappe.session.user
        assignment.weekly_plan = self.name
        assignment.insert(ignore_permissions=True)

        line.approval_status = "Approved"
        line.manager_comment = None
        line.visit_assignment = assignment.name

    def _finalise_review(self):
        """Recompute the plan's overall status from its lines and stamp
        the review. Called after every decision so a plan that started
        as line-by-line still closes out correctly."""
        statuses = [ln.approval_status for ln in self.planned_visits]

        if "Pending" in statuses:
            # Mid-review: the manager decided some lines but not all.
            # The plan stays up for approval until nothing is pending.
            self.status = "Pending Approval"
        elif "Rejected" not in statuses:
            self.status = "Approved"
        elif "Approved" not in statuses:
            self.status = "Rejected"
        else:
            self.status = "Partially Approved"

        self.reviewed_by = frappe.session.user
        self.reviewed_on = now_datetime()
        self.save(ignore_permissions=True)
