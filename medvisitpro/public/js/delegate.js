(function () {
  "use strict";

  const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const pageData = JSON.parse(document.getElementById("page-data").textContent);
  let assignments = pageData.assignments || [];
  let activeDay = null; // null = show all days
  let activeStatuses = new Set(["Pending", "Completed", "Missed"]);
  let itemsCache = null;
  let currentAssignmentForVisit = null;
  let capturedLocation = null;
  // The delegate's Weekly Visit Plan for the week on screen. Held
  // separately from `assignments` on purpose: a plan line is only a
  // proposal, an assignment is a visit they can actually do.
  let plan = null;
  let planWeekStart = pageData.week_start_date;
  let draftLines = [];       // Scheduled lines the delegate is editing
  let planLoadFailed = false;
  let pickedPlanCustomer = null;
  let pickedAdhocCustomer = null;

  // ---------- API helper ----------
  async function callApi(method, args) {
    const res = await fetch(`/api/method/medvisitpro.api.${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Frappe-CSRF-Token": window.CSRF_TOKEN,
      },
      credentials: "same-origin",
      body: JSON.stringify(args || {}),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(extractFrappeError(data));
    }
    return data.message;
  }

  function extractFrappeError(data) {
    // Frappe's error responses put the real message inside
    // _server_messages, which is itself a JSON-encoded array of
    // JSON-encoded objects. Unwrap that instead of showing a
    // generic fallback whenever something goes wrong.
    if (data && data._server_messages) {
      try {
        const messages = JSON.parse(data._server_messages);
        const parsed = messages.map((m) => {
          try {
            return JSON.parse(m).message || m;
          } catch (e) {
            return m;
          }
        });
        if (parsed.length) return parsed.join(" ");
      } catch (e) {
        // fall through to other checks below
      }
    }
    if (data && data.exception) return data.exception;
    if (data && data.message) return data.message;
    return "Request failed";
  }

  // ---------- Header / greeting ----------
  function initHeader() {
    document.getElementById("delegateNameLabel").textContent = window.DELEGATE_NAME;
    const initials = window.DELEGATE_NAME.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    document.getElementById("delegateInitials").textContent = initials;

    const hour = new Date().getHours();
    const firstName = window.DELEGATE_NAME.split(" ")[0];
    let greeting = "Hi";
    if (hour >= 5 && hour < 12) greeting = "Good morning";
    else if (hour >= 12 && hour < 18) greeting = "Good afternoon";
    else greeting = "Good evening";
    document.getElementById("greeting").textContent = `${greeting}, ${firstName}`;

    const today = new Date();
    document.getElementById("dateSubtext").textContent =
      "Here is your visit schedule for " +
      today.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) + ".";
    MedvisitPro.initLiveClock("liveClock");
  }

  // ---------- Day tabs ----------
  function initDayTabs() {
    const container = document.getElementById("dayTabs");
    container.innerHTML = "";

    const todayIdx = (new Date().getDay() + 6) % 7; // convert Sun=0 -> Mon=0 indexing
    activeDay = todayIdx <= 5 ? todayIdx : null; // default to today if Mon-Sat

    DAY_NAMES.forEach((name, idx) => {
      const btn = document.createElement("button");
      btn.className = dayTabClass(idx === activeDay);
      btn.textContent = idx === todayIdx ? `${name} (Today)` : name;
      btn.dataset.day = idx;
      btn.addEventListener("click", () => {
        activeDay = activeDay === idx ? null : idx; // click again to clear filter
        refreshDayTabStyles();
        renderCards();
      });
      container.appendChild(btn);
    });
  }

  function dayTabClass(active) {
    return active
      ? "w-full text-left px-sm py-2 rounded-lg bg-primary text-on-primary font-body-sm text-body-sm transition-all"
      : "w-full text-left px-sm py-2 rounded-lg text-on-surface-variant hover:bg-surface-container font-body-sm text-body-sm transition-all";
  }

  function refreshDayTabStyles() {
    document.querySelectorAll("#dayTabs button").forEach((btn) => {
      const idx = Number(btn.dataset.day);
      btn.className = dayTabClass(idx === activeDay);
    });
  }

  // ---------- Status filters ----------
  function initStatusFilters() {
    document.querySelectorAll(".status-filter").forEach((cb) => {
      cb.addEventListener("change", () => {
        const status = cb.dataset.status;
        if (cb.checked) activeStatuses.add(status);
        else activeStatuses.delete(status);
        renderCards();
      });
    });
  }

  // ---------- Progress ----------
  function updateProgress() {
    const total = assignments.length;
    const completed = assignments.filter((a) => a.status === "Completed").length;
    document.getElementById("progressText").textContent = `${completed} of ${total} visits`;
    const pct = total ? Math.round((completed / total) * 100) : 0;
    requestAnimationFrame(() => {
      document.getElementById("progressBar").style.width = pct + "%";
    });
  }

  // ---------- Card rendering ----------
  function weekdayIndex(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    return (d.getDay() + 6) % 7;
  }

  function renderCards() {
    const grid = document.getElementById("clientGrid");
    grid.innerHTML = "";

    const visible = assignments.filter((a) => {
      const dayMatch = activeDay === null || weekdayIndex(a.scheduled_date) === activeDay;
      const statusMatch = activeStatuses.has(a.status);
      return dayMatch && statusMatch;
    });

    if (visible.length === 0) {
      grid.innerHTML = `
        <div class="col-span-full text-center py-xl text-on-surface-variant">
          <span class="material-symbols-outlined !text-[48px] mb-sm block">event_available</span>
          No visits match the current filters.
        </div>`;
    }

    visible.forEach((a) => grid.appendChild(buildCard(a)));

    // Trailing "add new" tile
    const addTile = document.createElement("div");
    addTile.className =
      "border-2 border-dashed border-outline-variant rounded-xl flex flex-col items-center justify-center p-xl group cursor-pointer hover:bg-surface-container transition-colors";
    addTile.innerHTML = `
      <span class="material-symbols-outlined text-outline-variant group-hover:text-primary text-[48px] mb-sm transition-colors">add_circle</span>
      <p class="font-label-md text-label-md text-on-surface-variant group-hover:text-primary transition-colors">Add New Client Visit</p>`;
    addTile.addEventListener("click", openAddClientModal);
    grid.appendChild(addTile);
  }

  function buildCard(a) {
    const card = document.createElement("div");

    if (a.status === "Completed") {
      card.className = "bg-surface-container-low p-md rounded-xl border border-outline-variant opacity-80";
      card.innerHTML = `
        <div class="flex justify-between items-start mb-sm">
          <div class="bg-secondary-container text-on-secondary-container px-sm py-1 rounded-full text-label-sm font-label-sm flex items-center gap-1">
            <span class="material-symbols-outlined text-[14px]" style="font-variation-settings:'FILL' 1;">check_circle</span>
            Completed
          </div>
          <span class="font-label-sm text-label-sm text-on-surface-variant">${a.scheduled_time || ""}</span>
        </div>
        <h3 class="font-headline-md text-headline-md text-on-surface-variant mb-1">${escapeHtml(a.customer_name)}</h3>
        <p class="font-body-sm text-body-sm text-on-surface-variant mb-md">${escapeHtml(a.address || "")}</p>
        <div class="mt-md pt-md border-t border-outline-variant flex items-center justify-between gap-sm">
          <div class="flex items-center gap-sm text-secondary">
            <span class="material-symbols-outlined">task_alt</span>
            <span class="font-label-md">Visit summary submitted</span>
          </div>
          ${mapLink(a)}
        </div>`;
      return card;
    }

    if (a.status === "Missed") {
      card.className = "bg-surface-container-lowest p-md rounded-xl border border-error border-opacity-30 ambient-shadow";
      card.innerHTML = `
        <div class="flex justify-between items-start mb-sm">
          <div class="bg-error-container text-on-error-container px-sm py-1 rounded-full text-label-sm font-label-sm flex items-center gap-1">
            <span class="material-symbols-outlined text-[14px]">warning</span>
            Missed
          </div>
          <span class="font-label-sm text-label-sm text-error">Reschedule Required</span>
        </div>
        <h3 class="font-headline-md text-headline-md text-on-surface mb-1">${escapeHtml(a.customer_name)}</h3>
        <p class="font-body-sm text-body-sm text-on-surface-variant mb-md">${escapeHtml(a.address || "")}</p>
        <div class="flex items-center gap-sm mt-md">
          <button class="bg-error hover:bg-red-700 text-on-error px-md py-2 rounded-lg font-label-md transition-colors active:scale-95 reschedule-btn">Reschedule</button>
        </div>`;
      card.querySelector(".reschedule-btn").addEventListener("click", () => rescheduleVisit(a));
      return card;
    }

    // Pending
    card.className = "bg-surface-container-lowest p-md rounded-xl border-l-4 border-l-primary border border-outline-variant ambient-shadow hover:scale-[1.01] transition-transform duration-200";
    card.innerHTML = `
      <div class="flex justify-between items-start mb-sm">
        <div class="bg-primary-container text-on-primary-container px-sm py-1 rounded-full text-label-sm font-label-sm flex items-center gap-1">
          <span class="material-symbols-outlined text-[14px]">schedule</span>
          Pending
        </div>
        <span class="font-label-sm text-label-sm text-on-surface-variant">${a.scheduled_time ? "Scheduled: " + a.scheduled_time : ""}</span>
      </div>
      <h3 class="font-headline-md text-headline-md text-on-surface mb-1">${escapeHtml(a.customer_name)}</h3>
      <p class="font-body-sm text-body-sm text-on-surface-variant mb-md">${escapeHtml(a.address || "")}</p>
      <div class="flex items-center gap-sm mt-md">
        <button class="bg-primary hover:bg-primary-container text-on-primary px-lg py-2 rounded-lg font-label-md transition-colors flex items-center gap-xs active:scale-95 start-visit-btn">
          <span class="material-symbols-outlined text-[18px]">play_arrow</span>
          Start Visit
        </button>
      </div>`;
    card.querySelector(".start-visit-btn").addEventListener("click", () => openVisitModal(a));
    return card;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  function mapLink(a) {
    if (!a.checkin_latitude || !a.checkin_longitude) return "";
    const url = `https://www.google.com/maps?q=${a.checkin_latitude},${a.checkin_longitude}`;
    const approx = a.checkin_location_source && a.checkin_location_source !== "GPS";
    return `<a href="${url}" target="_blank" rel="noopener" class="text-label-sm text-primary hover:underline flex items-center gap-1">
      <span class="material-symbols-outlined text-[16px]">location_on</span>
      View on Map
    </a>${approx ? '<span class="text-label-sm text-amber-600 ml-1" title="Network-based location — may be inaccurate">(approx.)</span>' : ""}`;
  }

  // ---------- Visit modal: location gate ----------
  function openVisitModal(assignment) {
    currentAssignmentForVisit = assignment;
    capturedLocation = null;

    document.getElementById("locationGateStep").classList.remove("hidden");
    document.getElementById("visitForm").classList.add("hidden");
    document.getElementById("locationError").classList.add("hidden");

    const modal = document.getElementById("visitModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }

  function closeVisitModal() {
    const modal = document.getElementById("visitModal");
    modal.classList.add("hidden");
    modal.classList.remove("flex");
    currentAssignmentForVisit = null;
    capturedLocation = null;
  }

  // GPS accuracy is reported as a radius in meters (68% confidence).
  // REQUIRED_ACCURACY_METERS is a hard gate, not just a warning
  // threshold: a visit cannot be logged on a fix worse than this.
  // SAMPLE_WINDOW_MS: after the first fix arrives, keep listening
  // this much longer for a better one before giving up — the first
  // fix from watchPosition is often a stale/coarse one.
  // GPS_TIMEOUT_MS: give up entirely if no fix at all arrives in
  // this time (the delegate must then retry).
  const REQUIRED_ACCURACY_METERS = 50;
  const SAMPLE_WINDOW_MS = 8000;
  const GPS_TIMEOUT_MS = 20000;

  // A real GPS fix always reports a positive accuracy radius
  // (typically several meters at best) — 0, missing, or NaN is not a
  // more-precise reading, it means the device/browser didn't supply
  // a trustworthy figure at all (seen on laptops with no GPS radio,
  // where the browser silently substitutes network/IP positioning
  // through the same success callback). That case must fail the
  // precision gate the same as a genuinely poor fix.
  function hasUsableAccuracy(accuracy) {
    return typeof accuracy === "number" && isFinite(accuracy) && accuracy > 0;
  }

  async function requestLocation() {
    const errEl = document.getElementById("locationError");
    errEl.classList.add("hidden");

    if (!navigator.geolocation) {
      errEl.textContent =
        "This device doesn't support GPS location access. A precise GPS location is required " +
        "to log a visit — please use a phone with location services enabled.";
      errEl.classList.remove("hidden");
      return;
    }

    const btn = document.getElementById("enableLocationBtn");
    btn.disabled = true;
    btn.textContent = "Locating...";

    try {
      const pos = await getBestGpsFix();
      const accuracy = pos.coords.accuracy;
      const usable = hasUsableAccuracy(accuracy);
      // The strict ceiling only applies once this customer already has
      // a registered reference location — their first-ever visit is
      // what sets it, so it isn't held to the ceiling yet (mirrors the
      // server-side rule in api.py's _validate_precise_location).
      const ceilingApplies = !!(currentAssignmentForVisit && currentAssignmentForVisit.customer_has_prior_location);
      // Dev-only escape hatch (window.RELAX_LOCATION_GATE, set from the
      // medvisitpro_relax_location_gate site config) lets a laptop with
      // no GPS clear this pre-check; the server gates honour the same
      // switch. Off in production. Still requires *some* usable fix —
      // this can't help when the browser returns no location at all
      // (e.g. an insecure-context origin blocking geolocation).
      const relaxGate = !!window.RELAX_LOCATION_GATE;
      const precise = usable && (relaxGate || !ceilingApplies || accuracy <= REQUIRED_ACCURACY_METERS);

      if (!precise) {
        capturedLocation = null;
        errEl.textContent = usable
          ? `Location isn't precise enough to log this visit (accuracy ~${Math.round(accuracy)}m, ` +
            `need ${REQUIRED_ACCURACY_METERS}m or better). Move outdoors or near a window with a clear ` +
            "view of the sky and try again."
          : "This device didn't report a reliable GPS accuracy. Make sure GPS / High Accuracy " +
            "location mode is enabled (not just Wi-Fi/network location) and try again.";
        errEl.classList.remove("hidden");
        return;
      }

      capturedLocation = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy,
        source: "GPS",
      };
      showVisitForm();
    } catch (e) {
      // Permission denied, timed out, or GPS hardware unavailable.
      // There is no fallback here on purpose — an approximate
      // location is not an acceptable substitute for a real check-in.
      errEl.textContent =
        "Could not get a precise GPS location (permission denied or GPS unavailable). Enable " +
        "location access with GPS / High Accuracy mode and try again.";
      errEl.classList.remove("hidden");
    } finally {
      btn.disabled = false;
      btn.textContent = "Enable Location & Continue";
    }
  }

  // Samples watchPosition readings instead of taking the first fix
  // getCurrentPosition returns, since that first fix is frequently a
  // coarse/cached one even with enableHighAccuracy. Keeps the best
  // (lowest-accuracy-number) reading seen, and returns as soon as a
  // fix meeting the required precision arrives or the sampling
  // window closes.
  function getBestGpsFix() {
    return new Promise((resolve, reject) => {
      let best = null;
      let watchId = null;
      let sampleWindowTimer = null;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(giveUpTimer);
        clearTimeout(sampleWindowTimer);
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        if (best) resolve(best);
        else reject(new Error("No GPS fix"));
      };

      const giveUpTimer = setTimeout(finish, GPS_TIMEOUT_MS);

      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (!best || pos.coords.accuracy < best.coords.accuracy) {
            best = pos;
          }
          if (pos.coords.accuracy <= REQUIRED_ACCURACY_METERS) {
            finish();
            return;
          }
          if (!sampleWindowTimer) {
            sampleWindowTimer = setTimeout(finish, SAMPLE_WINDOW_MS);
          }
        },
        () => finish(),
        { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 0 }
      );
    });
  }

  async function showVisitForm() {
    document.getElementById("locationGateStep").classList.add("hidden");
    const form = document.getElementById("visitForm");
    form.classList.remove("hidden");
    document.getElementById("visitFormClientName").textContent = currentAssignmentForVisit.customer_name;
    document.getElementById("discussionNotes").value = "";
    document.getElementById("outcomeSelect").value = "";
    document.getElementById("visitFormError").classList.add("hidden");
    updateVisitFormLocationStatus();
    await populateProductsSelect();
  }

  function updateVisitFormLocationStatus() {
    const statusEl = document.getElementById("visitFormLocationStatus");
    if (!capturedLocation) return;
    statusEl.className = "font-body-sm text-body-sm text-secondary flex items-center gap-1";
    statusEl.innerHTML = `<span class="material-symbols-outlined text-[16px]">check_circle</span>
      Precise location captured (±${Math.round(capturedLocation.accuracy)}m)`;
  }

  // item name -> selling rate, built from itemsCache so order lines
  // can be priced and totalled without the delegate typing a price.
  let itemRateMap = {};

  async function populateProductsSelect() {
    const select = document.getElementById("productsSelect");
    select.innerHTML = "";
    if (!itemsCache) {
      try {
        itemsCache = await callApi("get_items", {});
      } catch (e) {
        itemsCache = [];
      }
    }
    itemRateMap = {};
    itemsCache.forEach((item) => {
      itemRateMap[item.name] = Number(item.rate) || 0;
      const opt = document.createElement("option");
      opt.value = item.name;
      opt.textContent = item.item_name || item.name;
      select.appendChild(opt);
    });
    renderOrderLines(); // nothing selected yet → hides the order section
  }

  function fmtMoney(n) {
    return (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  // Rebuilds the order rows from the current product selection. Each
  // selected product gets a quantity input; a quantity of 0 means the
  // product was only discussed, not ordered.
  function renderOrderLines() {
    const select = document.getElementById("productsSelect");
    const container = document.getElementById("orderLines");
    const section = document.getElementById("orderSection");
    const selected = Array.from(select.selectedOptions);

    section.classList.toggle("hidden", selected.length === 0);
    container.innerHTML = "";

    selected.forEach((opt) => {
      const rate = itemRateMap[opt.value] || 0;
      const row = document.createElement("div");
      row.className = "flex items-center gap-sm";
      row.innerHTML = `
        <div class="flex-grow min-w-0">
          <p class="font-body-md text-body-md text-on-surface truncate">${escapeHtml(opt.textContent)}</p>
          <p class="font-label-sm text-label-sm text-on-surface-variant">Rate: ${fmtMoney(rate)}</p>
        </div>
        <input type="number" min="0" step="1" value="0" inputmode="numeric"
          class="w-20 p-xs rounded-lg border border-outline-variant outline-none focus:border-primary text-right order-qty"
          data-item="${escapeHtml(opt.value)}" data-rate="${rate}">
        <span class="w-24 text-right font-label-md text-label-md order-line-total">0</span>`;
      container.appendChild(row);
    });

    container.querySelectorAll(".order-qty").forEach((inp) => {
      inp.addEventListener("input", recomputeOrder);
    });
    recomputeOrder();
  }

  function recomputeOrder() {
    let total = 0;
    document.querySelectorAll("#orderLines .order-qty").forEach((inp) => {
      const qty = Math.max(0, parseFloat(inp.value) || 0);
      const rate = parseFloat(inp.dataset.rate) || 0;
      const lineTotal = qty * rate;
      total += lineTotal;
      const totalEl = inp.parentElement.querySelector(".order-line-total");
      if (totalEl) totalEl.textContent = fmtMoney(lineTotal);
    });
    document.getElementById("orderTotal").textContent = fmtMoney(total);

    // Reflect whether an order is being placed in the submit button.
    const btn = document.getElementById("completeVisitBtn");
    btn.textContent = total > 0 ? "Complete Visit & Place Order" : "Complete Visit";
  }

  async function submitVisitForm(e) {
    e.preventDefault();
    const errEl = document.getElementById("visitFormError");
    errEl.classList.add("hidden");

    const outcome = document.getElementById("outcomeSelect").value;
    if (!outcome) {
      errEl.textContent = "Please select an outcome.";
      errEl.classList.remove("hidden");
      return;
    }
    if (!capturedLocation) {
      errEl.textContent = "Location was not captured. Please restart this visit.";
      errEl.classList.remove("hidden");
      return;
    }

    // Quantities come from the order rows; a product selected but left
    // at 0 is recorded as discussed only (no order line).
    const qtyByItem = {};
    document.querySelectorAll("#orderLines .order-qty").forEach((inp) => {
      qtyByItem[inp.dataset.item] = Math.max(0, parseFloat(inp.value) || 0);
    });
    const selectedProducts = Array.from(document.getElementById("productsSelect").selectedOptions).map((o) => ({
      item: o.value,
      qty: qtyByItem[o.value] || 0,
    }));

    const btn = document.getElementById("completeVisitBtn");
    btn.disabled = true;
    btn.textContent = "Saving...";

    try {
      const result = await callApi("submit_visit", {
        assignment: currentAssignmentForVisit.name,
        latitude: capturedLocation.latitude,
        longitude: capturedLocation.longitude,
        accuracy: capturedLocation.accuracy,
        location_source: capturedLocation.source,
        discussion_notes: document.getElementById("discussionNotes").value,
        outcome: outcome,
        products: JSON.stringify(selectedProducts),
      });

      currentAssignmentForVisit.status = "Completed";
      closeVisitModal();
      renderCards();
      updateProgress();
      const successMsg = result && result.sales_order
        ? "Visit submitted and draft order placed for your manager to confirm."
        : "Visit submitted successfully.";
      if (window.MedvisitPro) MedvisitPro.showToast(successMsg, "success");
    } catch (err) {
      errEl.textContent = err.message || "Something went wrong. Please try again.";
      if (window.MedvisitPro) MedvisitPro.showToast(errEl.textContent, "error");
      errEl.classList.remove("hidden");
    } finally {
      btn.disabled = false;
      btn.textContent = "Complete Visit";
    }
  }

  // ---------- Reschedule ----------
  async function rescheduleVisit(assignment) {
    const newDate = prompt("Reschedule to which date? (YYYY-MM-DD)");
    if (!newDate) return;
    try {
      await callApi("reschedule_visit", { assignment: assignment.name, new_date: newDate });
      assignment.status = "Pending";
      assignment.scheduled_date = newDate;
      renderCards();
      updateProgress();
    } catch (err) {
      alert(err.message || "Could not reschedule this visit.");
    }
  }

  // ---------- Request an unplanned (ad-hoc) visit ----------
  // Two steps: pick the client, then justify it. This no longer
  // creates anything the delegate can act on — the request lands on
  // this week's plan and waits for the manager.
  function openAddClientModal() {
    document.getElementById("customerSearchInput").value = "";
    document.getElementById("customerResults").innerHTML = "";
    document.getElementById("adhocReason").value = "";
    hideError("adhocError");
    pickedAdhocCustomer = null;
    showAdhocStep("search");
    const modal = document.getElementById("addClientModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    document.getElementById("customerSearchInput").focus();
  }

  function showAdhocStep(step) {
    document.getElementById("adhocSearchStep").classList.toggle("hidden", step !== "search");
    document.getElementById("adhocReasonStep").classList.toggle("hidden", step !== "reason");
  }

  function closeAddClientModal() {
    const modal = document.getElementById("addClientModal");
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }

  let searchTimeout = null;
  async function handleCustomerSearch(e) {
    clearTimeout(searchTimeout);
    const txt = e.target.value;
    searchTimeout = setTimeout(async () => {
      const results = await callApi("search_customers", { txt });
      const container = document.getElementById("customerResults");
      container.innerHTML = "";
      results.forEach((c) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "w-full text-left px-sm py-2 rounded-lg hover:bg-surface-container font-body-sm text-body-sm";
        row.textContent = c.customer_name;
        row.addEventListener("click", () => selectCustomerForAdhocVisit(c));
        container.appendChild(row);
      });
    }, 300);
  }

  function selectCustomerForAdhocVisit(customer) {
    pickedAdhocCustomer = customer;
    document.getElementById("adhocClientName").textContent = customer.customer_name;
    fillContactSelect("adhocContactSelect", customer.name, "Point of contact (optional)");
    showAdhocStep("reason");
    document.getElementById("adhocReason").focus();
  }

  async function sendAdhocRequest(e) {
    e.preventDefault();
    hideError("adhocError");

    const reason = document.getElementById("adhocReason").value.trim();
    if (!reason) {
      showError("adhocError", "Give a reason for this visit.");
      return;
    }

    const btn = document.getElementById("sendAdhocBtn");
    btn.disabled = true;
    try {
      const result = await callApi("request_adhoc_visit", {
        customer: pickedAdhocCustomer.name,
        reason: reason,
        contact_person: selectedContact("adhocContactSelect"),
      });
      plan = result.plan;
      closeAddClientModal();
      renderPlanChip();
      MedvisitPro.showToast(
        "Sent to your manager. You can check in once it's approved."
      );
    } catch (err) {
      showError("adhocError", err.message || "Could not send this request.");
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Point of contact ----------
  // A client's contacts are fetched on demand rather than shipped with
  // the page: most clients have one or two, and the delegate only
  // needs them for the client they're actually adding.
  async function fillContactSelect(selectId, customer, placeholder) {
    const select = document.getElementById(selectId);
    select.innerHTML = '<option value="">' + placeholder + "</option>";
    select.disabled = true;
    if (!customer) return;

    try {
      const contacts = await callApi("get_customer_contacts", { customer: customer });
      contacts.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.name;
        opt.textContent = c.designation ? c.display_name + " — " + c.designation : c.display_name;
        // Kept separately (not just parsed back out of textContent) so
        // a plan line can show Speciality as its own field — see
        // addPlanLine.
        opt.dataset.name = c.display_name;
        opt.dataset.speciality = c.designation || "";
        select.appendChild(opt);
      });
      select.disabled = false;
      // One contact on file means there's nothing to choose — pick it
      // rather than making the delegate confirm the obvious.
      if (contacts.length === 1) select.value = contacts[0].name;
    } catch (e) {
      // The contact is optional, so a failed lookup must not block
      // planning — but it must not look like "this client has nobody
      // on file" either, or the delegate silently plans without the
      // person they meant to see.
      select.innerHTML = '<option value="">Couldn\'t load contacts — continuing without one</option>';
      select.disabled = true;
      MedvisitPro.showToast("Couldn't load contacts for this client.", "error");
    }
  }

  function selectedContact(selectId) {
    return document.getElementById(selectId).value || null;
  }

  // ---------- Weekly planner ----------

  function showError(id, msg) {
    const el = document.getElementById(id);
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  function hideError(id) {
    document.getElementById(id).classList.add("hidden");
  }

  const PLAN_CHIP_STYLES = {
    "Draft": "bg-surface-container text-on-surface-variant",
    "Pending Approval": "bg-tertiary-container text-on-surface",
    "Approved": "bg-secondary text-on-primary",
    "Partially Approved": "bg-tertiary-container text-on-surface",
    "Rejected": "bg-error-container text-on-surface",
  };

  const PLAN_HINTS = {
    "Draft": "Not sent yet. Plan your week and send it for approval.",
    "Pending Approval": "With your manager. You'll see approved visits appear here.",
    "Approved": "Your whole week is approved.",
    "Partially Approved": "Some visits were sent back. Open the planner to fix them.",
    "Rejected": "Sent back by your manager. Open the planner to see why.",
  };

  function renderPlanChip() {
    const chip = document.getElementById("planStatusChip");
    const hint = document.getElementById("planStatusHint");

    if (planLoadFailed) {
      chip.innerHTML =
        '<span class="inline-block px-sm py-1 rounded-full font-label-sm text-label-sm bg-error-container text-on-surface">Couldn\'t load</span>';
      hint.textContent = "Open the planner to try again.";
      return;
    }

    if (!plan) {
      chip.innerHTML =
        '<span class="inline-block px-sm py-1 rounded-full font-label-sm text-label-sm bg-surface-container text-on-surface-variant">No plan yet</span>';
      hint.textContent = "You haven't planned this week yet.";
      return;
    }

    const style = PLAN_CHIP_STYLES[plan.status] || "bg-surface-container text-on-surface-variant";
    const pendingAdhoc = plan.counts.pending_adhoc;
    chip.innerHTML =
      '<span class="inline-block px-sm py-1 rounded-full font-label-sm text-label-sm ' +
      style + '">' + escapeHtml(plan.status) + "</span>" +
      (pendingAdhoc
        ? '<span class="inline-block ml-1 px-sm py-1 rounded-full font-label-sm text-label-sm bg-tertiary-container text-on-surface">' +
          pendingAdhoc + " ad-hoc waiting</span>"
        : "");
    hint.textContent = PLAN_HINTS[plan.status] || "";
  }

  async function openPlanner() {
    const modal = document.getElementById("planModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    document.getElementById("planLines").innerHTML =
      '<p class="font-body-sm text-body-sm text-on-surface-variant">Loading...</p>';

    try {
      const data = await callApi("get_week_plan", { week_start_date: planWeekStart });
      plan = data.plan;
      planWeekStart = data.week_start_date;
      planLoadFailed = false;
      seedDraftFromPlan();
      renderPlanner();
      renderPlanChip();
    } catch (err) {
      document.getElementById("planLines").innerHTML = "";
      showError("planError", err.message || "Could not load your plan.");
    }
  }

  function closePlanner() {
    const modal = document.getElementById("planModal");
    modal.classList.add("hidden");
    modal.classList.remove("flex");
    hideError("planError");
  }

  function planIsEditable() {
    return !plan || plan.editable;
  }

  function seedDraftFromPlan() {
    // Only Scheduled lines still open to change are editable here.
    // Approved lines are already real visits, and Ad-hoc lines are
    // raised from the field — both are shown read-only.
    draftLines = plan
      ? plan.lines
          .filter((l) => l.visit_type === "Scheduled" && l.approval_status !== "Approved")
          .map((l) => ({
            customer: l.customer,
            customer_name: l.customer_name,
            customer_category: l.customer_category,
            expected_visits_per_month: l.expected_visits_per_month,
            contact_person: l.contact_person,
            contact_person_name: l.contact_person_name,
            contact_speciality: l.contact_speciality,
            scheduled_date: l.scheduled_date,
            scheduled_time: l.scheduled_time,
            approval_status: l.approval_status,
            manager_comment: l.manager_comment,
          }))
      : [];
  }

  function fixedLines() {
    if (!plan) return [];
    return plan.lines.filter(
      (l) => l.approval_status === "Approved" || l.visit_type === "Ad-hoc"
    );
  }

  function planWeekLabel() {
    const start = new Date(planWeekStart + "T00:00:00");
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const fmt = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return "Week of " + fmt(start) + " – " + fmt(end);
  }

  function renderPlanner() {
    document.getElementById("planWeekLabel").textContent = planWeekLabel();
    renderPlanBanner();
    renderPlanLines();

    const editable = planIsEditable();
    document.getElementById("planEditor").classList.toggle("hidden", !editable);
    document.getElementById("savePlanBtn").classList.toggle("hidden", !editable);
    document.getElementById("submitPlanBtn").classList.toggle("hidden", !editable);

    // Confine the date picker to the plan's own week — the server
    // rejects anything outside it, so don't let it be picked at all.
    const dateInput = document.getElementById("planDateInput");
    const end = new Date(planWeekStart + "T00:00:00");
    end.setDate(end.getDate() + 6);
    const today = new Date().toISOString().slice(0, 10);
    dateInput.min = planWeekStart > today ? planWeekStart : today;
    dateInput.max = end.toISOString().slice(0, 10);
  }

  function renderPlanBanner() {
    const banner = document.getElementById("planBanner");
    if (!plan || !plan.manager_comment) {
      banner.classList.add("hidden");
      return;
    }
    banner.className =
      "mt-md p-sm rounded-lg bg-error-container font-body-sm text-body-sm text-on-surface";
    banner.innerHTML =
      '<span class="font-label-md text-label-md">Manager: </span>' +
      escapeHtml(plan.manager_comment);
    banner.classList.remove("hidden");
  }

  function lineBadge(status, visitType) {
    const styles = {
      "Approved": "bg-secondary text-on-primary",
      "Rejected": "bg-error-container text-on-surface",
      "Pending": "bg-tertiary-container text-on-surface",
    };
    let html =
      '<span class="px-sm py-1 rounded-full font-label-sm text-label-sm ' +
      (styles[status] || styles.Pending) + '">' + escapeHtml(status) + "</span>";
    if (visitType === "Ad-hoc") {
      html +=
        '<span class="ml-1 px-sm py-1 rounded-full font-label-sm text-label-sm bg-surface-container text-on-surface-variant">Ad-hoc</span>';
    }
    return html;
  }

  function planRow(inner) {
    const div = document.createElement("div");
    div.className =
      "flex items-start justify-between gap-sm p-sm rounded-lg border border-outline-variant";
    div.innerHTML = inner;
    return div;
  }

  // One line combining who (Point of Contact — Speciality) and what
  // they're worth covering (Org-Type · expected visits/month) — so a
  // plan line answers "who am I seeing, at what kind of place, and
  // are they due" without opening the client detail separately.
  function planLineMeta(l) {
    const parts = [];
    if (l.contact_person_name) {
      parts.push(
        l.contact_speciality
          ? escapeHtml(l.contact_person_name) + " — " + escapeHtml(l.contact_speciality)
          : escapeHtml(l.contact_person_name)
      );
    }
    const orgBits = [];
    if (l.customer_category) orgBits.push(escapeHtml(l.customer_category));
    if (l.expected_visits_per_month) orgBits.push(l.expected_visits_per_month + "/mo expected");
    if (orgBits.length) parts.push(orgBits.join(" · "));
    return parts.length
      ? '<p class="font-body-sm text-body-sm text-on-surface-variant">' + parts.join(" · ") + "</p>"
      : "";
  }

  function renderPlanLines() {
    const container = document.getElementById("planLines");
    container.innerHTML = "";

    const fixed = fixedLines();
    if (!fixed.length && !draftLines.length) {
      container.innerHTML =
        '<p class="font-body-sm text-body-sm text-on-surface-variant">Nothing planned for this week yet. Add your visits below.</p>';
      return;
    }

    fixed.forEach((l) => {
      container.appendChild(
        planRow(
          '<div class="min-w-0">' +
            '<p class="font-label-md text-label-md truncate">' + escapeHtml(l.customer_name) + "</p>" +
            '<p class="font-body-sm text-body-sm text-on-surface-variant">' +
              escapeHtml(l.scheduled_date || "") + (l.scheduled_time ? " · " + escapeHtml(l.scheduled_time) : "") +
            "</p>" +
            planLineMeta(l) +
            (l.reason
              ? '<p class="font-body-sm text-body-sm text-on-surface-variant mt-1">Reason: ' + escapeHtml(l.reason) + "</p>"
              : "") +
            (l.manager_comment
              ? '<p class="font-body-sm text-body-sm text-error mt-1">' + escapeHtml(l.manager_comment) + "</p>"
              : "") +
          "</div>" +
          '<div class="flex-shrink-0">' + lineBadge(l.approval_status, l.visit_type) + "</div>"
        )
      );
    });

    draftLines.forEach((l, idx) => {
      const row = planRow(
        '<div class="min-w-0">' +
          '<p class="font-label-md text-label-md truncate">' + escapeHtml(l.customer_name) + "</p>" +
          '<p class="font-body-sm text-body-sm text-on-surface-variant">' +
            escapeHtml(l.scheduled_date || "") + (l.scheduled_time ? " · " + escapeHtml(l.scheduled_time) : "") +
          "</p>" +
          planLineMeta(l) +
          (l.manager_comment
            ? '<p class="font-body-sm text-body-sm text-error mt-1">Sent back: ' + escapeHtml(l.manager_comment) + "</p>"
            : "") +
        "</div>" +
        '<div class="flex items-center gap-sm flex-shrink-0">' +
          (l.approval_status === "Rejected" ? lineBadge("Rejected", "Scheduled") : "") +
          '<button type="button" class="material-symbols-outlined text-on-surface-variant hover:text-error" data-remove="' + idx + '">delete</button>' +
        "</div>"
      );
      row.querySelector("[data-remove]").addEventListener("click", () => {
        draftLines.splice(idx, 1);
        renderPlanLines();
      });
      container.appendChild(row);
    });
  }

  let planSearchTimeout = null;
  function handlePlanCustomerSearch(e) {
    clearTimeout(planSearchTimeout);
    pickedPlanCustomer = null;
    fillContactSelect("planContactSelect", null, "Point of contact — pick a client first");
    const txt = e.target.value;
    const box = document.getElementById("planCustomerResults");

    planSearchTimeout = setTimeout(async () => {
      const results = await callApi("search_customers", { txt });
      box.innerHTML = "";
      if (!results.length) {
        box.classList.add("hidden");
        return;
      }
      results.forEach((c) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className =
          "w-full text-left px-sm py-2 rounded-lg hover:bg-surface-container font-body-sm text-body-sm";
        btn.textContent = c.customer_name;
        btn.addEventListener("click", () => {
          pickedPlanCustomer = c;
          document.getElementById("planCustomerInput").value = c.customer_name;
          box.classList.add("hidden");
          fillContactSelect("planContactSelect", c.name, "Point of contact (optional)");
        });
        box.appendChild(btn);
      });
      box.classList.remove("hidden");
    }, 300);
  }

  function addPlanLine() {
    hideError("planEditorError");
    const date = document.getElementById("planDateInput").value;
    const time = document.getElementById("planTimeInput").value;

    if (!pickedPlanCustomer) {
      showError("planEditorError", "Pick a client from the list first.");
      return;
    }
    if (!date) {
      showError("planEditorError", "Pick a date for this visit.");
      return;
    }

    const contactSelect = document.getElementById("planContactSelect");
    const contactOpt = contactSelect.value ? contactSelect.selectedOptions[0] : null;
    draftLines.push({
      customer: pickedPlanCustomer.name,
      customer_name: pickedPlanCustomer.customer_name,
      customer_category: pickedPlanCustomer.customer_category,
      expected_visits_per_month: pickedPlanCustomer.expected_visits_per_month,
      contact_person: selectedContact("planContactSelect"),
      contact_person_name: contactOpt ? contactOpt.dataset.name : "",
      contact_speciality: contactOpt ? contactOpt.dataset.speciality : "",
      scheduled_date: date,
      scheduled_time: time || null,
      approval_status: "Pending",
      manager_comment: null,
    });

    pickedPlanCustomer = null;
    document.getElementById("planCustomerInput").value = "";
    document.getElementById("planTimeInput").value = "";
    fillContactSelect("planContactSelect", null, "Point of contact — pick a client first");
    renderPlanLines();
  }

  function draftPayload() {
    return draftLines.map((l) => ({
      customer: l.customer,
      contact_person: l.contact_person,
      scheduled_date: l.scheduled_date,
      scheduled_time: l.scheduled_time,
    }));
  }

  async function savePlan(silent) {
    hideError("planError");
    const result = await callApi("save_week_plan", {
      week_start_date: planWeekStart,
      lines: JSON.stringify(draftPayload()),
    });
    plan = result.plan;
    seedDraftFromPlan();
    renderPlanner();
    renderPlanChip();
    if (!silent) MedvisitPro.showToast("Draft saved.");
  }

  async function handleSavePlan() {
    const btn = document.getElementById("savePlanBtn");
    btn.disabled = true;
    try {
      await savePlan(false);
    } catch (err) {
      showError("planError", err.message || "Could not save your plan.");
    } finally {
      btn.disabled = false;
    }
  }

  async function handleSubmitPlan() {
    const btn = document.getElementById("submitPlanBtn");
    btn.disabled = true;
    hideError("planError");
    try {
      // Save first so the server reviews exactly what's on screen —
      // otherwise unsaved additions would be silently dropped.
      await savePlan(true);
      const result = await callApi("submit_week_plan", { week_start_date: planWeekStart });
      plan = result.plan;
      seedDraftFromPlan();
      renderPlanner();
      renderPlanChip();
      MedvisitPro.showToast("Plan sent to your manager for approval.");
    } catch (err) {
      showError("planError", err.message || "Could not send your plan.");
    } finally {
      btn.disabled = false;
    }
  }

  async function loadPlanChip() {
    try {
      const data = await callApi("get_week_plan", { week_start_date: planWeekStart });
      plan = data.plan;
      planWeekStart = data.week_start_date;
      planLoadFailed = false;
    } catch (e) {
      // Leave `plan` untouched. Reporting "No plan yet" here would be a
      // lie the delegate could act on — they'd re-plan a week that is
      // already sitting with their manager.
      planLoadFailed = true;
    }
    renderPlanChip();
  }

  // ---------- Init ----------
  document.addEventListener("DOMContentLoaded", () => {
    initHeader();
    initDayTabs();
    initStatusFilters();
    updateProgress();
    renderCards();

    document.getElementById("enableLocationBtn").addEventListener("click", requestLocation);
    document.getElementById("cancelLocationBtn").addEventListener("click", closeVisitModal);
    document.getElementById("cancelVisitFormBtn").addEventListener("click", closeVisitModal);
    document.getElementById("visitForm").addEventListener("submit", submitVisitForm);
    document.getElementById("productsSelect").addEventListener("change", renderOrderLines);

    document.getElementById("cancelAddClientBtn").addEventListener("click", closeAddClientModal);
    document.getElementById("customerSearchInput").addEventListener("input", handleCustomerSearch);
    document.getElementById("mobileAddBtn").addEventListener("click", openAddClientModal);

    document.getElementById("adhocReasonStep").addEventListener("submit", sendAdhocRequest);
    document.getElementById("backToSearchBtn").addEventListener("click", () => showAdhocStep("search"));

    document.getElementById("openPlannerBtn").addEventListener("click", openPlanner);
    document.getElementById("closePlanBtn").addEventListener("click", closePlanner);
    document.getElementById("planCustomerInput").addEventListener("input", handlePlanCustomerSearch);
    document.getElementById("addPlanLineBtn").addEventListener("click", addPlanLine);
    document.getElementById("savePlanBtn").addEventListener("click", handleSavePlan);
    document.getElementById("submitPlanBtn").addEventListener("click", handleSubmitPlan);

    document.getElementById("openMyClientsBtn").addEventListener("click", openMyClients);
    document.getElementById("closeMyClientsBtn").addEventListener("click", closeMyClients);
    document.getElementById("myClientsModal").addEventListener("click", (e) => {
      if (e.target.id === "myClientsModal") closeMyClients();
    });

    loadPlanChip();
  });

  // ---------- My Clients ----------
  // The delegate's own assigned-client roster: every organization they
  // own, grouped, with each named point of contact and their
  // speciality — the manager-side get_delegate_portfolio, scoped to
  // the logged-in delegate instead of picked from the Delegates table.

  function closeMyClients() {
    const modal = document.getElementById("myClientsModal");
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }

  function groupPortfolioByOrganization(rows) {
    const groups = [];
    const byCustomer = {};
    rows.forEach((row) => {
      if (!byCustomer[row.customer]) {
        byCustomer[row.customer] = {
          organization: row.organization, customer_class: row.customer_class,
          province: row.province, district: row.district, contacts: [],
        };
        groups.push(byCustomer[row.customer]);
      }
      if (row.point_of_contact) {
        byCustomer[row.customer].contacts.push({
          name: row.point_of_contact, speciality: row.speciality, phone: row.phone,
        });
      }
    });
    return groups;
  }

  function renderMyClients(groups) {
    if (!groups.length) {
      return '<p class="font-body-sm text-body-sm text-on-surface-variant py-md">No clients assigned to you yet — check with your manager.</p>';
    }
    return groups
      .map((g) => {
        const location = [g.province, g.district].filter(Boolean).join(" · ");
        const contacts = g.contacts.length
          ? g.contacts
              .map(
                (c) =>
                  `<div class="flex items-center justify-between py-xs border-b border-outline-variant last:border-0">` +
                  `<span class="font-body-sm text-body-sm text-on-surface">${escapeHtml(c.name)}${c.speciality ? " — " + escapeHtml(c.speciality) : ""}</span>` +
                  `<span class="font-body-sm text-body-sm text-on-surface-variant">${escapeHtml(c.phone || "")}</span>` +
                  `</div>`
              )
              .join("")
          : '<p class="font-body-sm text-body-sm text-on-surface-variant py-xs">No named contact on file yet.</p>';
        return `
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant p-md mb-sm">
            <div class="flex items-start justify-between gap-sm mb-xs">
              <h3 class="font-label-md text-label-md text-on-surface">${escapeHtml(g.organization)}</h3>
              <span class="font-label-sm text-label-sm text-on-surface-variant">${escapeHtml(g.customer_class)}</span>
            </div>
            ${location ? `<p class="font-body-sm text-body-sm text-on-surface-variant mb-sm">${escapeHtml(location)}</p>` : ""}
            <div>${contacts}</div>
          </div>`;
      })
      .join("");
  }

  async function openMyClients() {
    const body = document.getElementById("myClientsBody");
    body.innerHTML = '<p class="font-body-sm text-body-sm text-on-surface-variant py-md">Loading…</p>';
    const modal = document.getElementById("myClientsModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    try {
      const data = await callApi("get_my_clients", {});
      body.innerHTML = renderMyClients(groupPortfolioByOrganization(data.rows));
    } catch (err) {
      body.innerHTML = `<p class="font-body-sm text-body-sm text-error py-md">${escapeHtml(err.message || "Could not load your clients.")}</p>`;
    }
  }
})();
