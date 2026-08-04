import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime

from medvisitpro.utils import (
    GEOFENCE_RADIUS_METERS,
    customer_has_registered_location,
    haversine_distance_meters,
    is_geofence_enabled,
    is_location_gate_relaxed,
)

REQUIRED_LOCATION_ACCURACY_METERS = 50


class Visit(Document):
    def validate(self):
        self.enforce_location_captured()
        self.enforce_geofence()
        self.set_checkin_time()
        self.copy_visit_type()
        self.sync_geolocation()
        self.reverse_geocode()

    def after_insert(self):
        self.lock_customer_location_if_first_visit()

    def reverse_geocode(self):
        """Resolves lat/lng into a human-readable address using
        OpenStreetMap Nominatim — free, no API key required.

        Only runs when coordinates are present and checkin_address
        hasn't been populated yet (first save only — avoids
        unnecessary re-fetching on subsequent edits).

        Nominatim usage policy: max 1 req/second, must identify the
        application via a User-Agent header. Fine for one-at-a-time
        visit check-ins. Fails silently so a geocoding failure never
        blocks a delegate from saving their visit."""
        if self.checkin_address:
            return
        if not (self.checkin_latitude and self.checkin_longitude):
            return
        try:
            lat = float(self.checkin_latitude)
            lng = float(self.checkin_longitude)
        except (TypeError, ValueError):
            return

        try:
            import requests
            response = requests.get(
                "https://nominatim.openstreetmap.org/reverse",
                params={"lat": lat, "lon": lng, "format": "json", "addressdetails": 1},
                headers={"User-Agent": "MedvisitPro/1.0 (mbonimpasylvain@gmail.com)"},
                timeout=5,
            )
            if response.status_code == 200:
                data = response.json()
                addr = data.get("address", {})

                # Build a concise address: house number + road +
                # suburb + city. Avoids the very long display_name
                # which includes country, postcode etc.
                parts = []
                if addr.get("house_number"):
                    parts.append(addr["house_number"])
                if addr.get("road"):
                    parts.append(addr["road"])
                suburb = addr.get("suburb") or addr.get("neighbourhood")
                if suburb:
                    parts.append(suburb)
                city = addr.get("city") or addr.get("town") or addr.get("village")
                if city:
                    parts.append(city)

                self.checkin_address = (
                    ", ".join(parts) if parts else data.get("display_name", "")
                )
        except Exception:
            pass  # silently ignore — visit still saves without an address

    def sync_geolocation(self):
        """Populates the Geolocation field (interactive map in Desk)
        from the raw lat/lng captured at check-in."""
        if not (self.checkin_latitude and self.checkin_longitude):
            return
        try:
            lat = float(self.checkin_latitude)
            lng = float(self.checkin_longitude)
        except (TypeError, ValueError):
            return

        self.checkin_location = frappe.as_json({
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {},
                    "geometry": {"type": "Point", "coordinates": [lng, lat]},
                }
            ],
        })

    def copy_visit_type(self):
        """Denormalize visit_type from the parent Visit Assignment so
        weekly reports can filter by it directly without a join."""
        if self.visit_assignment and not self.visit_type:
            self.visit_type = frappe.db.get_value(
                "Visit Assignment", self.visit_assignment, "visit_type"
            )

    def enforce_location_captured(self):
        """Server-side enforcement of the location-gate rule. The
        precise-accuracy check only applies to brand-new visits —
        older records created before this rule existed (or with a
        looser source) must stay editable, not become permanently
        stuck failing validation on every future save."""
        if not self.checkin_latitude or not self.checkin_longitude:
            frappe.throw(
                _("A Visit cannot be saved without a captured location. "
                  "Please enable location access before logging this visit."),
                title=_("Location Required")
            )
        if self.is_new():
            self.enforce_precise_location()

    def enforce_precise_location(self):
        """The real, unbypassable gate: a new Visit must carry a
        genuine GPS fix, not an approximate/unverified one. Mirrors
        api.py's _validate_precise_location, which exists only to
        give the delegate a friendlier error earlier.

        The strict <=50m ceiling only applies once this customer
        already has a registered reference location — the first
        Visit for a customer is what sets that reference point, so
        it isn't held to the same ceiling yet (still must be a real
        GPS reading with a genuine accuracy figure though)."""
        # Dev/testing escape hatch (off in production) — see
        # is_location_gate_relaxed(). Kept in sync with the same skip
        # in api.py's _validate_precise_location.
        if is_location_gate_relaxed():
            return
        if self.checkin_location_source != "GPS" or not self.checkin_accuracy:
            frappe.throw(
                _("A genuine GPS location is required to log this visit. Approximate or "
                  "unverified-accuracy locations are not accepted."),
                title=_("Location Not Precise Enough"),
            )

        if (
            customer_has_registered_location(self.customer)
            and self.checkin_accuracy > REQUIRED_LOCATION_ACCURACY_METERS
        ):
            frappe.throw(
                _("A precise GPS location (accuracy of {0}m or better) is required to log this "
                  "visit. Approximate or low-accuracy locations are not accepted.").format(
                    REQUIRED_LOCATION_ACCURACY_METERS
                ),
                title=_("Location Not Precise Enough"),
            )

    def enforce_geofence(self):
        """The real, unbypassable gate for the geofence rule: once a
        customer has a locked registered location (set by whichever
        Visit was created first for them — see after_insert below),
        every later Visit must check in within GEOFENCE_RADIUS_METERS
        of it. The very first Visit for a customer has nothing to
        compare against yet, since it's what sets the lock.

        Gated behind is_geofence_enabled() — off in dev/staging,
        turned on in production via site_config.json."""
        if not is_geofence_enabled():
            return
        if not self.is_new():
            return

        registered = frappe.db.get_value(
            "Customer", self.customer, ["registered_latitude", "registered_longitude"]
        )
        if not registered or not registered[0] or not registered[1]:
            return

        distance = haversine_distance_meters(
            float(self.checkin_latitude), float(self.checkin_longitude),
            float(registered[0]), float(registered[1]),
        )
        if distance > GEOFENCE_RADIUS_METERS:
            frappe.throw(
                _("You appear to be about {0}m from this client's registered location. Visits "
                  "must be logged within {1}m of the client's site.").format(
                    round(distance), GEOFENCE_RADIUS_METERS
                ),
                title=_("Not At Client Location"),
            )

    def lock_customer_location_if_first_visit(self):
        """The very first Visit ever logged for a customer defines
        that customer's ground-truth location going forward — see
        enforce_geofence above. Never overwrites an existing lock;
        correcting a bad lock is a System-Manager-only action on the
        Customer record itself (see customer_hooks.py).

        Gated behind is_geofence_enabled() — see enforce_geofence."""
        if not is_geofence_enabled():
            return

        existing = frappe.db.get_value(
            "Customer", self.customer, ["registered_latitude", "registered_longitude"]
        )
        if existing and existing[0] and existing[1]:
            return

        frappe.db.set_value(
            "Customer",
            self.customer,
            {
                "registered_latitude": self.checkin_latitude,
                "registered_longitude": self.checkin_longitude,
                "registered_location_visit": self.name,
                "registered_location_locked_on": now_datetime(),
            },
        )

    def set_checkin_time(self):
        if not self.checkin_time:
            self.checkin_time = now_datetime()

    def on_update(self):
        self.update_visit_assignment()

    def update_visit_assignment(self):
        """Mark the parent Visit Assignment as Completed and link
        this Visit back to it."""
        if not self.visit_assignment:
            return
        frappe.db.set_value(
            "Visit Assignment",
            self.visit_assignment,
            {"status": "Completed", "visit": self.name},
        )
