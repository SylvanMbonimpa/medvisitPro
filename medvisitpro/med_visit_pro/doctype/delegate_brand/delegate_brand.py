from frappe.model.document import Document


class DelegateBrand(Document):
    """One brand a delegate (or delegate manager) is responsible for.

    A child table on User rather than a single Link field: the business
    runs reps who carry more than one principal's portfolio, and the same
    is true of the managers over them.
    """

    pass
