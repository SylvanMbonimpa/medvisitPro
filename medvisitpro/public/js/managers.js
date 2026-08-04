(function () {
  "use strict";

  const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const pageData = JSON.parse(document.getElementById("page-data").textContent);
  let assignments = pageData.assignments || [];
  let activeDay = null;
  let activeStatuses = new Set(["Pending", "Completed", "Missed"]);
  // Free-text filter from the top app bar, applied in renderCards().
  let dashboardSearch = "";
  let selectedDelegate = null;
  let selectedCustomer = null;

  const callApi = MedvisitPro.callApi;
  const escapeHtml = MedvisitPro.escapeHtml;

  // ---------- Confirm Action modal ----------
  // One shared dialog for every delete/archive action on this page,
  // instead of the browser's own confirm() — styled consistently with
  // the rest of the app, and able to carry a longer explanation of
  // what the action actually does (e.g. that "archive" isn't a real
  // delete).
  let confirmActionHandler = null;

  function openConfirmModal({ title, message, confirmLabel, onConfirm }) {
    document.getElementById("confirmActionTitle").textContent = title || "Are you sure?";
    document.getElementById("confirmActionMessage").textContent = message || "";
    document.getElementById("confirmActionConfirmBtn").textContent = confirmLabel || "Confirm";
    confirmActionHandler = onConfirm;
    const modal = document.getElementById("confirmActionModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }

  function closeConfirmModal() {
    const modal = document.getElementById("confirmActionModal");
    modal.classList.add("hidden");
    modal.classList.remove("flex");
    confirmActionHandler = null;
  }

  function initHeader() {
    const hour = new Date().getHours();
    const firstName = (window.MANAGER_NAME || "").split(" ")[0];
    const greeting =
      hour >= 5 && hour < 12 ? "Good morning"
      : hour >= 12 && hour < 18 ? "Good afternoon"
      : "Good evening";
    document.getElementById("greeting").textContent = `${greeting}, ${firstName}`;
    MedvisitPro.initLiveClock("liveClock");
    // Name, avatar and dropdown are identical on every manager page.
    MedvisitPro.initProfileMenu();
  }

  function initDayTabs() {
    const container = document.getElementById("dayTabs");
    container.innerHTML = "";
    const todayIdx = (new Date().getDay() + 6) % 7;
    activeDay = todayIdx <= 5 ? todayIdx : null;

    DAY_NAMES.forEach((name, idx) => {
      const btn = document.createElement("button");
      btn.className = dayTabClass(idx === activeDay);
      btn.textContent = idx === todayIdx ? `${name} (Today)` : name;
      btn.dataset.day = idx;
      btn.addEventListener("click", () => {
        activeDay = activeDay === idx ? null : idx;
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
      btn.className = dayTabClass(Number(btn.dataset.day) === activeDay);
    });
  }

  function initStatusFilters() {
    document.querySelectorAll(".status-filter").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) activeStatuses.add(cb.dataset.status);
        else activeStatuses.delete(cb.dataset.status);
        renderCards();
      });
    });
  }

  function updateProgress() {
    const total = pageData.total || 0;
    const completed = pageData.completed || 0;
    document.getElementById("progressText").textContent = `${completed} of ${total} scheduled visits`;
    const pct = total ? Math.round((completed / total) * 100) : 0;
    requestAnimationFrame(() => {
      document.getElementById("progressBar").style.width = pct + "%";
    });
  }

  function weekdayIndex(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    return (d.getDay() + 6) % 7;
  }

  function renderCards() {
    const tbody = document.getElementById("clientGrid");
    const emptyState = document.getElementById("dashboardTableEmpty");
    tbody.innerHTML = "";

    const visible = assignments.filter((a) => {
      const dayMatch = activeDay === null || weekdayIndex(a.scheduled_date) === activeDay;
      const statusMatch = activeStatuses.has(a.status);
      const searchMatch =
        !dashboardSearch ||
        (a.customer_name || "").toLowerCase().includes(dashboardSearch) ||
        (a.delegate_name || "").toLowerCase().includes(dashboardSearch) ||
        (a.address || "").toLowerCase().includes(dashboardSearch);
      return dayMatch && statusMatch && searchMatch;
    });

    emptyState.textContent = dashboardSearch
      ? `No visits match "${dashboardSearch}".`
      : "No visits match the current filters.";
    emptyState.classList.toggle("hidden", visible.length > 0);
    visible.forEach((a) => tbody.appendChild(buildRow(a)));
  }

  // Pending = red per explicit request. Missed also red (still an
  // alarm state) but bold to distinguish from Pending at a glance.
  // Completed = green (secondary).
  function statusBadge(status) {
    if (status === "Completed") {
      return `<span class="text-secondary font-label-md">Completed</span>`;
    }
    if (status === "Missed") {
      return `<span class="text-error font-label-md font-bold">Missed</span>`;
    }
    return `<span class="text-error font-label-md">Pending</span>`;
  }

  function rowActions(a) {
    const historyLink = `<a href="/app/visit?customer=${encodeURIComponent(a.customer)}" target="_blank" rel="noopener" class="text-primary hover:underline">History</a>`;

    if (a.status === "Completed") {
      return `<div class="flex items-center gap-md">${historyLink} ${mapLink(a)}</div>`;
    }
    if (a.status === "Missed") {
      return `<div class="flex items-center gap-md">
        <button class="reassign-btn text-error hover:underline font-label-md" data-name="${a.name}">Reassign</button>
        ${historyLink}
      </div>`;
    }
    return `<div class="flex items-center gap-md">
      <button class="reassign-btn text-primary hover:underline font-label-md" data-name="${a.name}">Reassign</button>
      ${historyLink}
    </div>`;
  }

  function buildRow(a) {
    const tr = document.createElement("tr");
    tr.className = "border-b border-outline-variant last:border-0 hover:bg-surface-container-low";
    const typeBadge = a.visit_type === "Ad-hoc"
      ? `<span class="text-label-sm text-on-surface-variant italic ml-1">(ad-hoc)</span>` : "";

    tr.innerHTML = `
      <td class="py-2 px-md text-on-surface">${escapeHtml(a.delegate_name)}</td>
      <td class="py-2 px-md text-on-surface">${escapeHtml(a.customer_name)}${typeBadge}</td>
      <td class="py-2 px-md text-on-surface-variant">${escapeHtml(a.address || "—")}</td>
      <td class="py-2 px-md text-on-surface-variant">${escapeHtml(a.phone || "—")}</td>
      <td class="py-2 px-md">${statusBadge(a.status)}</td>
      <td class="py-2 px-md text-on-surface-variant">${escapeHtml(a.scheduled_date || "—")}</td>
      <td class="py-2 px-md">${rowActions(a)}</td>
    `;

    const reassignBtn = tr.querySelector(".reassign-btn");
    if (reassignBtn) {
      reassignBtn.addEventListener("click", () => reassignVisit(a));
    }
    return tr;
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

  async function reassignVisit(assignment) {
    const newDelegateName = prompt(`Reassign "${assignment.customer_name}" to which delegate's full name?`);
    if (!newDelegateName) return;

    try {
      const results = await callApi("search_delegates", { txt: newDelegateName });
      if (!results.length) {
        alert("No matching delegate found.");
        return;
      }
      await callApi("reassign_visit", { assignment: assignment.name, new_delegate: results[0].name });
      assignment.delegate = results[0].name;
      assignment.delegate_name = results[0].full_name;
      assignment.status = "Pending";
      renderCards();
    } catch (err) {
      alert(err.message || "Could not reassign this visit.");
    }
  }

  // ---------- Assign New Visit modal ----------
  function openAssignModal() {
    selectedDelegate = null;
    selectedCustomer = null;
    document.getElementById("delegateSearchInput").value = "";
    document.getElementById("assignCustomerSearchInput").value = "";
    document.getElementById("delegateResults").innerHTML = "";
    document.getElementById("assignCustomerResults").innerHTML = "";
    document.getElementById("selectedDelegateLabel").classList.add("hidden");
    document.getElementById("selectedCustomerLabel").classList.add("hidden");
    fillAssignContacts(null);
    document.getElementById("assignDateInput").value = new Date().toISOString().slice(0, 10);
    document.getElementById("assignError").classList.add("hidden");

    const modal = document.getElementById("assignModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }

  // Points of contact for the client being assigned. Optional: a
  // client with nobody on file is still assignable.
  async function fillAssignContacts(customer) {
    const select = document.getElementById("assignContactSelect");
    select.innerHTML = '<option value="">' + (customer ? "None" : "Pick a client first") + "</option>";
    select.disabled = !customer;
    if (!customer) return;

    try {
      const contacts = await callApi("get_customer_contacts", { customer });
      contacts.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.name;
        opt.textContent = c.designation ? c.display_name + " — " + c.designation : c.display_name;
        select.appendChild(opt);
      });
      if (contacts.length === 1) select.value = contacts[0].name;
    } catch (e) {
      // The contact is optional, so don't block the assignment — but
      // an empty dropdown here would read as "nobody on file", so say
      // what actually happened.
      select.innerHTML = '<option value="">Couldn\'t load contacts — continuing without one</option>';
      select.disabled = true;
      if (window.MedvisitPro) MedvisitPro.showToast("Couldn't load contacts for this client.", "error");
    }
  }

  function closeAssignModal() {
    const modal = document.getElementById("assignModal");
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }

  let delegateSearchTimeout = null;
  async function handleDelegateSearch(e) {
    clearTimeout(delegateSearchTimeout);
    const txt = e.target.value;
    delegateSearchTimeout = setTimeout(async () => {
      const results = await callApi("search_delegates", { txt });
      const container = document.getElementById("delegateResults");
      container.innerHTML = "";
      results.forEach((d) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "w-full text-left px-sm py-1 rounded-lg hover:bg-surface-container text-body-sm";
        row.textContent = d.full_name;
        row.addEventListener("click", () => {
          selectedDelegate = d;
          const label = document.getElementById("selectedDelegateLabel");
          label.textContent = `Selected: ${d.full_name}`;
          label.classList.remove("hidden");
          container.innerHTML = "";
        });
        container.appendChild(row);
      });
    }, 300);
  }

  let customerSearchTimeout = null;
  async function handleAssignCustomerSearch(e) {
    clearTimeout(customerSearchTimeout);
    const txt = e.target.value;
    customerSearchTimeout = setTimeout(async () => {
      const results = await callApi("search_customers", { txt });
      const container = document.getElementById("assignCustomerResults");
      container.innerHTML = "";
      results.forEach((c) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "w-full text-left px-sm py-1 rounded-lg hover:bg-surface-container text-body-sm";
        row.textContent = c.customer_name;
        row.addEventListener("click", () => {
          selectedCustomer = c;
          const label = document.getElementById("selectedCustomerLabel");
          label.textContent = `Selected: ${c.customer_name}`;
          label.classList.remove("hidden");
          container.innerHTML = "";
          fillAssignContacts(c.name);
        });
        container.appendChild(row);
      });
    }, 300);
  }

  async function confirmAssign() {
    const errEl = document.getElementById("assignError");
    errEl.classList.add("hidden");

    if (!selectedDelegate || !selectedCustomer) {
      errEl.textContent = "Please select both a delegate and a client.";
      errEl.classList.remove("hidden");
      return;
    }
    const date = document.getElementById("assignDateInput").value;
    if (!date) {
      errEl.textContent = "Please pick a date.";
      errEl.classList.remove("hidden");
      return;
    }

    try {
      const result = await callApi("assign_visit", {
        delegate: selectedDelegate.name,
        customer: selectedCustomer.name,
        scheduled_date: date,
        contact_person: document.getElementById("assignContactSelect").value || null,
      });
      assignments.push({
        name: result.assignment,
        delegate: selectedDelegate.name,
        delegate_name: selectedDelegate.full_name,
        customer: selectedCustomer.name,
        customer_name: selectedCustomer.customer_name,
        address: "",
        scheduled_date: date,
        scheduled_time: "",
        status: "Pending",
        visit_type: "Scheduled",
      });
      closeAssignModal();
      renderCards();
    } catch (err) {
      errEl.textContent = err.message || "Could not create this assignment.";
      errEl.classList.remove("hidden");
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById("tableDateFrom").max = today;
    document.getElementById("tableDateTo").max = today;
    document.getElementById("assignDateInput").min = today;

    // Navigation is wired FIRST, before anything that renders content.
    // If a panel below throws, the rest of this handler never runs — and
    // when that included the nav wiring, every sidebar item silently
    // stopped working and the page just sat on the dashboard. Whatever
    // else fails, the manager can still move around the app.
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.addEventListener("click", () => handleNav(btn.dataset.view));
    });
    // "View all delegates" and friends: a call to action carrying
    // data-view, not a nav element, so it isn't caught above.
    document.querySelectorAll("[data-view]:not(.nav-item)").forEach((btn) => {
      btn.addEventListener("click", () => handleNav(btn.dataset.view));
    });

    initHeader();
    initDayTabs();
    initStatusFilters();
    // Honour ?view= so a refresh, a bookmark, or a link from /report
    // opens the pane it names instead of always landing on the
    // dashboard. fromHistory: the URL already says this — restore the
    // pane to match it, don't write it back.
    const requestedView = new URLSearchParams(window.location.search).get("view");
    if (requestedView && requestedView !== "dashboard") {
      handleNav(requestedView, { fromHistory: true });
    } else {
      setActiveNav("dashboard");
    }
    // Seed history state so the first back/forward has a view to read.
    syncUrl(requestedView || "dashboard", true);
    updateProgress();
    renderCards();

    document.getElementById("delegateSearchInput").addEventListener("input", handleDelegateSearch);
    document.getElementById("assignCustomerSearchInput").addEventListener("input", handleAssignCustomerSearch);
    document.getElementById("confirmAssignBtn").addEventListener("click", confirmAssign);
    document.getElementById("cancelAssignBtn").addEventListener("click", closeAssignModal);
    document.getElementById("mobileAssignBtn").addEventListener("click", openAssignModal);
    document.getElementById("openAssignFromTableBtn").addEventListener("click", openAssignModal);

    document.getElementById("backToDashboardBtn").addEventListener("click", () => handleNav("dashboard"));
    document.getElementById("tableAddBtn").addEventListener("click", () => {
      if (currentTableView === "clients") openAddClientRecordModal();
      else if (currentTableView === "delegates") openAddDelegateModal();
    });
    document.getElementById("tablePrevBtn").addEventListener("click", () => changeTablePage(-1));
    document.getElementById("tableNextBtn").addEventListener("click", () => changeTablePage(1));
    document.getElementById("tableSearchInput").addEventListener("input", debounce(loadCurrentTableView, 300));
    document.getElementById("tableDelegateFilter").addEventListener("change", loadCurrentTableView);
    document.getElementById("tableStatusFilter").addEventListener("change", loadCurrentTableView);
    document.getElementById("tableDateFrom").addEventListener("change", loadCurrentTableView);
    document.getElementById("tableDateTo").addEventListener("change", loadCurrentTableView);
    document.getElementById("tableShowArchived").addEventListener("change", loadCurrentTableView);
    document.querySelectorAll(".view-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.mode === tableViewMode) return;
        tableViewMode = btn.dataset.mode;
        saveViewMode(currentTableView, tableViewMode);
        document.querySelectorAll(".view-mode-btn").forEach((b) => {
          const active = b === btn;
          b.classList.toggle("bg-primary", active);
          b.classList.toggle("text-on-primary", active);
          b.classList.toggle("text-on-surface-variant", !active);
        });
        renderTablePage();
      });
    });

    document.getElementById("openAddClientBtn").addEventListener("click", openAddClientRecordModal);
    document.getElementById("cancelAddClientRecordBtn").addEventListener("click", closeAddClientRecordModal);
    document.getElementById("confirmAddClientBtn").addEventListener("click", confirmAddClient);
    wireNewClientOrgPicker();

    document.getElementById("openAddDelegateBtn").addEventListener("click", openAddDelegateModal);
    document.getElementById("cancelAddDelegateBtn").addEventListener("click", closeAddDelegateModal);
    document.getElementById("confirmAddDelegateBtn").addEventListener("click", confirmAddDelegate);
    const newDelegateAlsoManagerEl = document.getElementById("newDelegateAlsoManager");
    if (newDelegateAlsoManagerEl) {
      newDelegateAlsoManagerEl.addEventListener("change", () => {
        document.getElementById("newDelegateBrandSection").classList.toggle("hidden", !newDelegateAlsoManagerEl.checked);
      });
    }

    // The bell is a shortcut to the same view the sidebar item opens —
    // it exists so the pending count is reachable at every breakpoint.
    //
    // In the shared shell it is an <a href="/managers?view=approvals">,
    // because on /report it has to be a real navigation. Here we are
    // already on that page, so suppress the href and switch panes
    // instead — otherwise the click both switches the view AND reloads
    // the page, throwing away the pane it just opened.
    document.getElementById("notificationsBtn").addEventListener("click", (e) => {
      e.preventDefault();
      handleNav("approvals");
    });

    initGlobalSearch();
    loadDashboardSummary();
  });

  // ---------- Add Client ----------
  // Set (not created here) whenever the Organization picker's search
  // result is clicked — see wireNewClientOrgPicker. null means the
  // typed name doesn't match anything on file, so submitting creates
  // a new Customer instead of editing one.
  let selectedExistingClient = null;

  async function openAddClientRecordModal() {
    ["newClientName", "newClientPhone", "newClientEmail", "newClientPointOfContact", "newClientSpeciality"].forEach((id) => {
      document.getElementById(id).value = "";
    });
    document.getElementById("newClientCategory").value = "";
    document.getElementById("newClientClass").value = "";
    document.getElementById("addClientError").classList.add("hidden");
    document.getElementById("newClientOrgResults").classList.add("hidden");
    document.getElementById("newClientOrgEditingNote").classList.add("hidden");
    document.getElementById("newClientOrgSimilarWarning").classList.add("hidden");
    selectedExistingClient = null;

    await ensureProvinceDistrictCache();
    const provinceSel = document.getElementById("newClientProvince");
    const districtSel = document.getElementById("newClientDistrict");
    provinceSel.innerHTML = '<option value="">—</option>' +
      Object.keys(provinceDistrictCache).map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
    populateDistrictSelect(districtSel, "", null);
    provinceSel.onchange = () => populateDistrictSelect(districtSel, provinceSel.value, null);

    const modal = document.getElementById("addClientRecordModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }

  function closeAddClientRecordModal() {
    const modal = document.getElementById("addClientRecordModal");
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }

  // Levenshtein edit distance, normalised to a 0–1 similarity score.
  // Used only for the near-duplicate-organization warning below —
  // search_customers' LIKE match can't catch "Kign Faisal Hospital"
  // as close to "King Faisal Hospital" (neither contains the other as
  // a substring), so this runs client-side against the full name list
  // instead (list_client_names, cached once per modal session).
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const row = [i];
      for (let j = 1; j <= n; j++) {
        row[j] = a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j - 1], prev[j], row[j - 1]);
      }
      prev = row;
    }
    return prev[n];
  }

  function nameSimilarity(a, b) {
    const na = a.trim().toLowerCase().replace(/\s+/g, " ");
    const nb = b.trim().toLowerCase().replace(/\s+/g, " ");
    if (!na || !nb) return 0;
    const maxLen = Math.max(na.length, nb.length);
    return 1 - levenshtein(na, nb) / maxLen;
  }

  // "Fairly loose" threshold — catches typos and case/spacing drift
  // ("Kign Faisal Hospital", "king   faisal hospital") without flagging
  // two genuinely different names that just share a word.
  const ORG_SIMILARITY_THRESHOLD = 0.75;

  let allClientNamesCache = null;
  async function ensureAllClientNamesCache() {
    if (!allClientNamesCache) allClientNamesCache = await callApi("list_client_names", {});
    return allClientNamesCache;
  }

  // Search-or-create picker on the Organization field: typing searches
  // existing clients (search_customers, already brand/session-scoped);
  // clicking a result prefills the org-level fields from
  // get_customer_details, so adding another Point of Contact to that
  // organization doesn't mean retyping its Org-Type/Category/Province/
  // District, and remembers which client this is so Save updates it
  // instead of creating a duplicate organization. Point of Contact/
  // Speciality/Phone are left for the manager to fill in fresh — an
  // organization can have several contacts, so there's no single one
  // to guess at from just picking the org.
  function wireNewClientOrgPicker() {
    const input = document.getElementById("newClientName");
    const results = document.getElementById("newClientOrgResults");
    const editingNote = document.getElementById("newClientOrgEditingNote");
    const similarWarning = document.getElementById("newClientOrgSimilarWarning");
    let searchTimer = null;

    async function selectExistingOrg(customer) {
      const d = await callApi("get_customer_details", { customer });
      selectedExistingClient = d.customer;
      input.value = d.customer_name;
      editingNote.classList.remove("hidden");
      similarWarning.classList.add("hidden");
      document.getElementById("newClientCategory").value =
        d.customer_category === "Uncategorized" ? "" : d.customer_category;
      document.getElementById("newClientClass").value = d.customer_class || "";

      const provinceSel = document.getElementById("newClientProvince");
      provinceSel.value = d.province || "";
      populateDistrictSelect(document.getElementById("newClientDistrict"), d.province || "", d.district || null);
    }

    input.addEventListener("input", () => {
      if (selectedExistingClient) {
        selectedExistingClient = null;
        editingNote.classList.add("hidden");
      }
      clearTimeout(searchTimer);
      const txt = input.value.trim();
      similarWarning.classList.add("hidden");
      if (!txt) {
        results.classList.add("hidden");
        results.innerHTML = "";
        return;
      }
      searchTimer = setTimeout(async () => {
        const [matches] = await Promise.all([
          callApi("search_customers", { txt }),
          ensureAllClientNamesCache(),
        ]);

        if (matches.length) {
          results.innerHTML = matches
            .map((m) => `<button type="button" class="new-client-org-result w-full text-left px-sm py-2 hover:bg-surface-container text-body-sm text-on-surface" data-customer="${escapeHtml(m.name)}">${escapeHtml(m.customer_name)}</button>`)
            .join("");
          results.classList.remove("hidden");
        } else {
          results.classList.add("hidden");
          results.innerHTML = "";
        }

        // Only warn about a name NOT already in the exact-match
        // results above — those are already one click away to pick.
        const matchedNames = new Set(matches.map((m) => m.customer_name.toLowerCase()));
        let best = null;
        for (const c of allClientNamesCache) {
          if (matchedNames.has(c.customer_name.toLowerCase())) continue;
          const score = nameSimilarity(txt, c.customer_name);
          if (score >= ORG_SIMILARITY_THRESHOLD && (!best || score > best.score)) {
            best = { ...c, score };
          }
        }
        if (best) {
          similarWarning.innerHTML =
            `Did you mean <button type="button" id="newClientOrgSimilarPick" class="underline font-semibold">${escapeHtml(best.customer_name)}</button>? ` +
            "A similar organization already exists — continuing will create a new, separate one.";
          similarWarning.classList.remove("hidden");
          document.getElementById("newClientOrgSimilarPick").addEventListener("click", () => selectExistingOrg(best.name));
        } else {
          similarWarning.classList.add("hidden");
        }
      }, 300);
    });

    results.addEventListener("click", (e) => {
      const btn = e.target.closest(".new-client-org-result");
      if (!btn) return;
      results.classList.add("hidden");
      results.innerHTML = "";
      selectExistingOrg(btn.dataset.customer);
    });

    document.addEventListener("click", (e) => {
      if (!results.contains(e.target) && e.target !== input) results.classList.add("hidden");
    });
  }

  async function confirmAddClient() {
    const errEl = document.getElementById("addClientError");
    errEl.classList.add("hidden");

    const customer_name = document.getElementById("newClientName").value.trim();
    const point_of_contact = document.getElementById("newClientPointOfContact").value.trim();
    const speciality = document.getElementById("newClientSpeciality").value.trim();
    const customer_category = document.getElementById("newClientCategory").value;
    const customer_class = document.getElementById("newClientClass").value;
    const province = document.getElementById("newClientProvince").value;
    const district = document.getElementById("newClientDistrict").value;
    const phone = document.getElementById("newClientPhone").value.trim();
    const email = document.getElementById("newClientEmail").value.trim();

    const required = [
      [customer_name, "Organization is required."],
      [point_of_contact, "Point of Contact is required."],
      [customer_category, "Org-Type is required."],
      [customer_class, "Category is required."],
      [province, "Province is required."],
      [district, "District is required."],
      [phone, "Phone number is required."],
    ];
    const missing = required.find(([value]) => !value);
    if (missing) {
      errEl.textContent = missing[1];
      errEl.classList.remove("hidden");
      return;
    }

    const btn = document.getElementById("confirmAddClientBtn");
    btn.disabled = true;
    btn.textContent = selectedExistingClient ? "Saving..." : "Adding...";

    try {
      const res = await callApi("save_client_record", {
        customer_name,
        point_of_contact,
        speciality: speciality || null,
        customer: selectedExistingClient || null,
        customer_category,
        customer_class,
        phone,
        email: email || null,
        province,
        district,
      });
      if (res && res.ok === false) {
        errEl.textContent = res.error || "Could not save this client.";
        errEl.classList.remove("hidden");
        if (window.MedvisitPro) MedvisitPro.showToast(errEl.textContent, "error");
        return;
      }
      const verb = selectedExistingClient ? "updated" : "added";
      closeAddClientRecordModal();
      if (window.MedvisitPro) MedvisitPro.showToast(`"${customer_name}" ${verb} successfully.`, "success");
      if (currentTableView === "clients") loadCurrentTableView();
    } catch (err) {
      errEl.textContent = err.message || "Could not save this client.";
      errEl.classList.remove("hidden");
      if (window.MedvisitPro) MedvisitPro.showToast(errEl.textContent, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Add Client";
    }
  }

  // ---------- Add Delegate ----------
  // The "make this a Delegate Manager" checkbox and brand picker only
  // exist in the DOM at all when window.IS_REGIONAL_MANAGER (see
  // managers.py get_context / managers.html) — a plain Delegate
  // Manager can't grant Delegate Manager access, so there's nothing to
  // show them there; see _require_regional_manager in api.py for the
  // actual enforcement.
  async function openAddDelegateModal() {
    ["newDelegateName", "newDelegateEmail", "newDelegateMobile"].forEach((id) => {
      document.getElementById(id).value = "";
    });
    document.getElementById("addDelegateError").classList.add("hidden");
    document.getElementById("delegateCreatedInfo").classList.add("hidden");

    const alsoManagerEl = document.getElementById("newDelegateAlsoManager");
    if (alsoManagerEl) {
      alsoManagerEl.checked = false;
      document.getElementById("newDelegateBrandSection").classList.add("hidden");
      if (!brandCache) brandCache = await callApi("list_all_brands", {});
      document.getElementById("newDelegateBrandList").innerHTML = brandCache.length
        ? brandCache.map((b) => `
            <label class="flex items-center gap-xs cursor-pointer">
              <input type="checkbox" class="new-delegate-brand rounded border-outline-variant text-primary focus:ring-primary" value="${escapeHtml(b)}">
              <span class="font-body-sm text-body-sm text-on-surface">${escapeHtml(b)}</span>
            </label>`).join("")
        : '<p class="font-body-sm text-body-sm text-on-surface-variant">No brands set up yet.</p>';
    }

    const modal = document.getElementById("addDelegateModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }

  function closeAddDelegateModal() {
    const modal = document.getElementById("addDelegateModal");
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }

  async function confirmAddDelegate() {
    const errEl = document.getElementById("addDelegateError");
    const infoEl = document.getElementById("delegateCreatedInfo");
    errEl.classList.add("hidden");
    infoEl.classList.add("hidden");

    const full_name = document.getElementById("newDelegateName").value.trim();
    const email = document.getElementById("newDelegateEmail").value.trim();
    if (!full_name || !email) {
      errEl.textContent = "Full name and email are required.";
      errEl.classList.remove("hidden");
      return;
    }

    const btn = document.getElementById("confirmAddDelegateBtn");
    btn.disabled = true;
    btn.textContent = "Adding...";

    const alsoManagerEl = document.getElementById("newDelegateAlsoManager");
    const alsoManager = alsoManagerEl ? alsoManagerEl.checked : false;
    const payload = {
      full_name,
      email,
      mobile_no: document.getElementById("newDelegateMobile").value.trim() || null,
      also_manager: alsoManager,
    };
    if (alsoManager) {
      payload.brands = JSON.stringify(
        [...document.querySelectorAll(".new-delegate-brand:checked")].map((cb) => cb.value)
      );
    }

    try {
      const result = await callApi("create_delegate", payload);

      if (result && result.ok === false) {
        errEl.textContent = result.error || "Could not add this delegate.";
        errEl.classList.remove("hidden");
        if (window.MedvisitPro) MedvisitPro.showToast(errEl.textContent, "error");
        return;
      }

      // Two onboarding paths depending on whether the site can send mail.
      if (result.emailed) {
        infoEl.textContent = `${full_name} added. A link to set their own password has been emailed to ${email}.`;
      } else {
        infoEl.textContent = `${full_name} added. Temporary password: ${result.temp_password} — share it with them (it won't be shown again). Email isn't configured, so nothing was sent automatically.`;
      }
      infoEl.classList.remove("hidden");

      if (window.MedvisitPro) MedvisitPro.showToast(`Delegate "${full_name}" added successfully.`, "success");
      delegateOptionsLoaded = false; // force refresh of the delegate filter dropdown next time it's opened
      if (currentTableView === "delegates") loadCurrentTableView();
    } catch (err) {
      errEl.textContent = err.message || "Could not add this delegate.";
      errEl.classList.remove("hidden");
      if (window.MedvisitPro) MedvisitPro.showToast(errEl.textContent, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Add Delegate";
    }
  }

  // ---------- Table view (Quick Links) ----------
  let currentTableView = null;
  let delegateOptionsLoaded = false;

  // Odoo-style optional columns: a view lists every column it *could*
  // show, each with a getter and whether it's on by default; the
  // manager's picks persist per view via localStorage
  // (mvp-columns-<view>). "locked: true" means always shown, not
  // offered in the picker — there has to be at least one column
  // nobody can turn off, or the table can go empty.
  const CLIENT_COLUMN_DEFS = [
    { key: "point_of_contact", label: "Specialist", locked: true, get: (r) => r.point_of_contact },
    { key: "organization", label: "Organization", default: true, get: (r) => r.organization },
    { key: "customer_category", label: "Org-Type", default: true, get: (r) => r.customer_category },
    { key: "phone", label: "Phone", default: true, get: (r) => r.phone || "—" },
    { key: "email", label: "Email", default: true, get: (r) => r.email || "Not registered" },
    { key: "customer_class", label: "Class", default: true, get: (r) => r.customer_class },
    { key: "expected_visits_per_month", label: "Expected Visits/Mo", default: true, get: (r) => (r.expected_visits_per_month ? String(r.expected_visits_per_month) : "—") },
    { key: "province", label: "Province", default: true, get: (r) => r.province || "—" },
    { key: "district", label: "District", default: true, get: (r) => r.district || "—" },
    // Off by default — useful, but not everyone needs it visible.
    { key: "last_updated_by", label: "Last Updated By", default: false, get: (r) => r.last_updated_by || "—" },
  ];

  const DELEGATE_COLUMN_DEFS = [
    { key: "full_name", label: "Name", locked: true, get: (r) => r.full_name },
    { key: "role", label: "Role", default: true, get: (r) => r.role },
    {
      key: "enabled", label: "Status", default: true,
      get: (r) => ({
        html: r.enabled
          ? '<span class="px-2 py-0.5 rounded-full bg-secondary-container text-on-secondary-container font-label-sm text-label-sm">Active</span>'
          : '<span class="px-2 py-0.5 rounded-full bg-error-container text-on-error-container font-label-sm text-label-sm">Disabled</span>',
      }),
    },
    { key: "manager_name", label: "Manager", default: true, get: (r) => r.manager_name || "—" },
    // Only a Regional Manager is unscoped with zero brands — see
    // manager_sees_all_brands (utils.py). A Delegate Manager with none
    // is a setup gap (they can't have delegates until they have at
    // least one — create_delegate/reassign_delegate refuse it), so
    // it's flagged rather than read as "sees everything".
    {
      key: "brands", label: "Brands", default: true,
      get: (r) => {
        if (r.brands && r.brands.length) return r.brands.join(", ");
        if (r.role === "Regional Manager") return { html: '<span class="text-on-surface-variant">All brands</span>' };
        if (r.role === "Delegate Manager") return { html: '<span class="text-error">No brands assigned</span>' };
        return "—";
      },
    },
    { key: "mobile_no", label: "Phone", default: true, get: (r) => r.mobile_no || "—" },
    { key: "territory", label: "Territory", default: true, get: (r) => r.territory || "—" },
    { key: "specialist_count", label: "Specialists", default: true, get: (r) => String(r.specialist_count) },
    { key: "email", label: "Email", default: true, get: (r) => r.email },
  ];

  const HISTORY_COLUMN_DEFS = [
    { key: "customer_name", label: "Client", locked: true, get: (r) => r.customer_name },
    { key: "delegate_name", label: "Delegate", default: true, get: (r) => r.delegate_name },
    {
      key: "status", label: "Status", default: true,
      get: (r) => ({
        html: statusBadge(r.status) +
          (r.archived ? ' <span class="ml-1 px-1.5 py-0.5 rounded-full bg-surface-container text-on-surface-variant font-label-sm text-label-sm">Archived</span>' : ""),
      }),
    },
    { key: "scheduled_date", label: "Scheduled Date", default: true, get: (r) => r.scheduled_date || "—" },
    { key: "visit_type", label: "Type", default: true, get: (r) => r.visit_type },
    {
      key: "checkin_location", label: "Check-in Location", default: true,
      get: (r) =>
        r.checkin_address
          ? { html: `${escapeHtml(r.checkin_address)}${
              r.checkin_location_source && r.checkin_location_source !== "GPS"
                ? ' <span class="text-amber-600" title="Network-based location — may be inaccurate">(approx.)</span>'
                : ""
            }` }
          : (r.checkin_latitude && r.checkin_longitude
            ? { html: `<a href="https://www.google.com/maps?q=${r.checkin_latitude},${r.checkin_longitude}" target="_blank" rel="noopener" class="text-primary hover:underline text-label-sm">View on Map</a>${
                r.checkin_location_source && r.checkin_location_source !== "GPS"
                  ? ' <span class="text-amber-600" title="Network-based location — may be inaccurate">(approx.)</span>'
                  : ""
              }` }
            : "—"),
    },
  ];

  // A function, not a plain array — "Discussed" needs the reporting
  // window's day count in its own label, which only list_products'
  // response knows (PRODUCT_WINDOW_DAYS, api.py).
  function productColumnDefs(days) {
    return [
      { key: "item_name", label: "Product", locked: true, get: (r) => r.item_name },
      { key: "item_group", label: "Group", default: true, get: (r) => r.item_group },
      { key: "rate", label: "Selling Rate", default: true, get: (r) => (r.rate ? r.rate.toLocaleString() : "—") },
      { key: "discussed", label: `Discussed (${days}d)`, default: true, get: (r) => String(r.discussed) },
      { key: "ordered", label: "Ordered", default: true, get: (r) => String(r.ordered) },
      {
        key: "conversion_percent", label: "Conversion", default: true,
        get: (r) => (r.conversion_percent === null ? { html: '<span class="text-outline">—</span>' } : { html: conversionBadge(r.conversion_percent) }),
      },
      // Off by default — a secondary detail (pack size/unit), not
      // something a manager scans the table for.
      { key: "uom", label: "Unit", default: false, get: (r) => r.uom || "—" },
    ];
  }

  function loadColumnPrefs(viewKey, defs) {
    const allKeys = defs.map((c) => c.key);
    const defaultKeys = defs.filter((c) => c.locked || c.default).map((c) => c.key);
    try {
      const raw = localStorage.getItem("mvp-columns-" + viewKey);
      if (!raw) return new Set(defaultKeys);
      const saved = JSON.parse(raw).filter((k) => allKeys.includes(k));
      return saved.length ? new Set(saved) : new Set(defaultKeys);
    } catch (e) {
      return new Set(defaultKeys);
    }
  }

  function saveColumnPrefs(viewKey, keySet) {
    localStorage.setItem("mvp-columns-" + viewKey, JSON.stringify(Array.from(keySet)));
  }

  // The defs currently enabled for a view, in their defined order —
  // locked columns always included regardless of saved prefs.
  function activeColumnDefs(viewKey, defs) {
    const enabled = loadColumnPrefs(viewKey, defs);
    return defs.filter((c) => c.locked || enabled.has(c.key));
  }

  // One entry per view wired up to the column picker — just Clients
  // for now. Adding another view's picker later is just adding its
  // defs array here and reading them via activeColumnDefs in that
  // view's branch of loadCurrentTableView.
  const VIEW_COLUMN_DEFS = {
    clients: CLIENT_COLUMN_DEFS,
    delegates: DELEGATE_COLUMN_DEFS,
    history: HISTORY_COLUMN_DEFS,
    // The picker only needs the label text, and the reporting window
    // is a fixed 90 days (PRODUCT_WINDOW_DAYS, api.py) — not actually
    // dynamic despite productColumnDefs taking it as a parameter for
    // loadCurrentTableView's use of the API's own echoed value.
    products: productColumnDefs(90),
  };

  function openColumnsPanel() {
    const defs = VIEW_COLUMN_DEFS[currentTableView];
    const panel = document.getElementById("tableColumnsPanel");
    if (!defs) {
      panel.classList.add("hidden");
      return;
    }
    const enabled = loadColumnPrefs(currentTableView, defs);
    panel.innerHTML = defs
      .filter((c) => !c.locked)
      .map(
        (c) =>
          `<label class="flex items-center gap-xs cursor-pointer py-1">` +
          `<input type="checkbox" class="table-column-toggle rounded border-outline-variant text-primary focus:ring-primary" ` +
          `value="${escapeHtml(c.key)}" ${enabled.has(c.key) ? "checked" : ""}>` +
          `<span class="font-body-sm text-body-sm text-on-surface">${escapeHtml(c.label)}</span>` +
          `</label>`
      )
      .join("");
    panel.querySelectorAll(".table-column-toggle").forEach((cb) => {
      cb.addEventListener("change", () => {
        const current = loadColumnPrefs(currentTableView, defs);
        if (cb.checked) current.add(cb.value);
        else current.delete(cb.value);
        // At least one toggleable column stays on — an all-off panel
        // would leave the table with only its locked column(s), which
        // reads as broken rather than "minimal".
        if (!cb.checked && current.size === 0) {
          cb.checked = true;
          current.add(cb.value);
        }
        saveColumnPrefs(currentTableView, current);
        loadCurrentTableView();
      });
    });
    panel.classList.remove("hidden");
  }

  function closeColumnsPanel() {
    document.getElementById("tableColumnsPanel").classList.add("hidden");
  }

  // Client-side pagination: rows are fetched in full, then sliced here.
  const TABLE_PAGE_SIZE = 10;
  let tableRows = [];
  let tableHeaders = [];
  // Parallel to tableRows: per-row metadata for rows that are
  // clickable (currently the Visit History view, where each row opens
  // the visit detail modal). Empty/undefined entries render as plain,
  // non-interactive rows — so the Clients and Delegates tables are
  // unaffected.
  let tableRowMeta = [];
  let tablePage = 1;

  // Column sort — persists across a search/refresh within the same
  // view (so typing in the search box doesn't drop it), but resets
  // whenever the header set changes (i.e. the manager switched views —
  // column 2 in Clients means something different than column 2 in
  // Delegates). Tracked by the header row's own text rather than a
  // separate "which view" flag, so it stays correct even if a view's
  // columns change later.
  let tableSortCol = null;
  let tableSortDir = "asc";
  let lastTableHeadersKey = null;

  // Client List row selection — Customer record names the manager has
  // checked, for a scoped export (the gear-icon panel). Keyed by record
  // name rather than page position so it survives pagination and a
  // changed search: check three rows, search for something else, the
  // three stay checked. Only ever populated while on the Clients view;
  // handleNav() clears it the moment the manager navigates elsewhere,
  // since a stale selection carried into another view would be
  // meaningless (a Delegate record name colliding with a Customer one
  // is astronomically unlikely, but "meaningless" is reason enough).
  let selectedClientIds = new Set();

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // ============================================================
  // Dashboard summary panels
  // ============================================================
  // Everything above the day/status filters on the dashboard, fed by
  // api.get_manager_dashboard(). Rendered client-side rather than
  // server-side like week_data because it is the slowest part of the
  // page to compute (a 90-day product scan and a 6-month trend), and
  // holding the whole first paint on it would be the wrong trade.

  async function loadDashboardSummary() {
    try {
      const d = await callApi("get_manager_dashboard", {});
      renderWeeklyStat(d.weekly);
      renderProductStat(d.top_product);
      renderDelegateStat(d.delegates);
      renderPerformanceTable(d.performance, d.client_classes);
    } catch (err) {
      // The panels keep their placeholder dashes. The rest of the
      // dashboard is server-rendered and unaffected, so a failure here
      // must not take the page down with it.
      if (window.MedvisitPro) {
        MedvisitPro.showToast(err.message || "Could not load dashboard summary.", "error");
      }
    }
  }

  function renderWeeklyStat(w) {
    document.getElementById("statVisitsCompleted").textContent = w.completed;

    const delta = document.getElementById("statVisitsDelta");
    const previous = document.getElementById("statVisitsPrevious");

    if (w.delta_percent === null || w.delta_percent === undefined) {
      // No visits last week means no baseline — showing "+100%" off zero
      // would be worse than showing nothing.
      delta.classList.add("hidden");
      delta.classList.remove("flex");
      previous.textContent = w.previous
        ? `vs ${w.previous} last week`
        : "No visits logged last week";
      return;
    }

    const up = w.delta_percent >= 0;
    delta.classList.remove("hidden");
    delta.classList.add("flex");
    delta.className =
      "flex items-center gap-0.5 px-2 py-0.5 rounded-full font-label-sm text-label-sm " +
      (up ? "text-secondary bg-secondary-container" : "text-error bg-error-container");
    delta.innerHTML =
      `<span class="material-symbols-outlined text-[14px]">${up ? "trending_up" : "trending_down"}</span>` +
      `${up ? "+" : ""}${w.delta_percent}%`;
    previous.textContent = `vs ${w.previous} last week`;
  }

  function renderProductStat(p) {
    const meta = document.getElementById("statProductMeta");
    if (!p) {
      document.getElementById("statProductName").textContent = "No products discussed yet";
      meta.textContent = "Logged visits will populate this.";
      return;
    }
    document.getElementById("statProductName").textContent = p.item_name;
    document.getElementById("statProductOrdered").textContent = `${p.ordered_percent}%`;
    document.getElementById("statProductDeclined").textContent = `${p.declined_percent}%`;
    meta.textContent =
      `Discussed on ${p.discussed} visit${p.discussed === 1 ? "" : "s"} in the last ${p.window_days} days`;
  }

  function renderDelegateStat(d) {
    document.getElementById("statDelegatesActive").textContent = d.active;
    document.getElementById("statDelegatesTotal").textContent = d.total;
    document.getElementById("statDelegatesBar").style.width =
      d.total ? `${Math.round((d.active / d.total) * 100)}%` : "0%";

    const wrap = document.getElementById("statDelegatesInactiveWrap");
    wrap.classList.toggle("hidden", !d.inactive);
    document.getElementById("statDelegatesInactive").textContent = `${d.inactive} out`;
  }

  function renderPerformanceTable(rows, classes) {
    const head = document.getElementById("perfTableHead");
    const body = document.getElementById("perfTableBody");
    const empty = document.getElementById("perfTableEmpty");

    head.innerHTML =
      '<th class="px-md py-sm font-medium">Delegate</th>' +
      classes
        .map((c) => `<th class="px-md py-sm font-medium whitespace-nowrap">${escapeHtml(c)}</th>`)
        .join("");

    const active = rows.filter((r) => r.enabled);
    if (!active.length) {
      body.innerHTML = "";
      empty.textContent = "No delegates yet. Add one from the sidebar.";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    // Only the busiest few; the full list is a click away.
    body.innerHTML = active
      .slice(0, 5)
      .map(
        (r) =>
          '<tr class="hover:bg-surface-container-low transition-colors">' +
          '<td class="px-md py-sm">' +
          '<div class="flex items-center gap-sm">' +
          '<div class="w-8 h-8 rounded-full bg-primary-container text-on-primary flex items-center justify-center font-label-sm flex-shrink-0">' +
          escapeHtml(r.initials) +
          "</div>" +
          `<span class="font-label-lg text-label-lg text-on-surface truncate">${escapeHtml(r.delegate_name)}</span>` +
          "</div></td>" +
          classes.map((c) => performanceCell(r.classes[c])).join("") +
          "</tr>"
      )
      .join("");
  }

  // A cell reads "done / planned". Complete is highlighted, a shortfall
  // is flagged, and a class the delegate holds nothing in is greyed to
  // an em dash so it doesn't read as a failure.
  function performanceCell(stat) {
    const done = (stat && stat.done) || 0;
    const planned = (stat && stat.planned) || 0;

    if (!planned) {
      return '<td class="px-md py-sm font-body-sm text-body-sm text-outline">—</td>';
    }
    const tone =
      done >= planned ? "text-secondary font-semibold"
      : done === 0 ? "text-error font-semibold"
      : "text-on-surface";
    return `<td class="px-md py-sm font-body-sm text-body-sm ${tone}">${done} / ${planned}</td>`;
  }

  // Filters the dashboard's visit table from the top-bar search box.
  // Deliberately client-side over the week payload already in memory —
  // it's the same data renderCards() draws from, so there's nothing to
  // fetch and it stays responsive per keystroke.
  function initGlobalSearch() {
    const input = document.getElementById("globalSearch");
    if (!input) return;
    input.addEventListener(
      "input",
      debounce(() => {
        dashboardSearch = input.value.trim().toLowerCase();
        renderCards();
      }, 200)
    );
  }

  // Highlights the sidebar MENU item matching the current view.
  function setActiveNav(view) {
    document.querySelectorAll(".nav-item").forEach((btn) => {
      const active = btn.dataset.view === view;
      btn.classList.toggle("bg-primary-container", active);
      btn.classList.toggle("text-on-primary-container", active);
      btn.classList.toggle("text-on-surface-variant", !active);
    });
  }

  // The address bar for a given pane. The dashboard is the bare path so
  // /managers stays the canonical entry point.
  function urlForView(view) {
    return view && view !== "dashboard"
      ? `/managers?view=${encodeURIComponent(view)}`
      : "/managers";
  }

  // Panes are swapped in place rather than loaded as pages, so the URL
  // has to be kept in step by hand. Without this the address bar always
  // reads /managers, and a refresh (or a bookmark, or the back button)
  // drops the manager back on the dashboard no matter which pane they
  // were on.
  function syncUrl(view, replace) {
    const url = urlForView(view);
    if (window.location.pathname + window.location.search === url) return;
    history[replace ? "replaceState" : "pushState"]({ view: view || "dashboard" }, "", url);
  }

  // Routes a MENU click: Dashboard and the table views switch panes;
  // "Most Ordered Products" is a placeholder, so it alerts without
  // changing the active highlight.
  //
  // `options.fromHistory` suppresses the URL write — set when the call
  // is itself a response to the URL (first paint, or back/forward), so
  // we don't push a duplicate entry for a location we're already at.
  function handleNav(view, options) {
    options = options || {};
    if (view !== "clients" && selectedClientIds.size) {
      selectedClientIds.clear();
    }
    if (view === "dashboard") {
      showDashboardView();
    } else if (view === "approvals") {
      showApprovalsView();
    } else {
      showTableView(view);
    }
    if (!options.fromHistory) syncUrl(view);
  }

  // Back/forward between panes. state is set by syncUrl; the query
  // string is the fallback for the entry the browser created itself.
  window.addEventListener("popstate", (event) => {
    const view =
      (event.state && event.state.view) ||
      new URLSearchParams(window.location.search).get("view") ||
      "dashboard";
    handleNav(view, { fromHistory: true });
  });

  function showDashboardView() {
    document.getElementById("dashboardView").classList.remove("hidden");
    document.getElementById("tableView").classList.add("hidden");
    document.getElementById("approvalsView").classList.add("hidden");
    document.getElementById("dashboardOnlySidebar").classList.remove("hidden");
    document.getElementById("dashboardOnlyStatusFilter").classList.remove("hidden");
    setActiveNav("dashboard");
    currentTableView = null;
  }

  async function showTableView(view) {
    currentTableView = view;
    closeColumnsPanel();
    tableViewMode = loadViewMode(view);
    document.querySelectorAll(".view-mode-btn").forEach((btn) => {
      const active = btn.dataset.mode === tableViewMode;
      btn.classList.toggle("bg-primary", active);
      btn.classList.toggle("text-on-primary", active);
      btn.classList.toggle("text-on-surface-variant", !active);
    });
    document.getElementById("dashboardView").classList.add("hidden");
    document.getElementById("approvalsView").classList.add("hidden");
    document.getElementById("tableView").classList.remove("hidden");
    document.getElementById("dashboardOnlySidebar").classList.add("hidden");
    document.getElementById("dashboardOnlyStatusFilter").classList.add("hidden");
    setActiveNav(view);
    document.getElementById("tableSearchInput").value = "";
    document.getElementById("tableDateFrom").value = "";
    document.getElementById("tableDateTo").value = "";
    document.getElementById("tableStatusFilter").value = "";

    const titles = {
      clients: "Client List",
      delegates: "Delegates",
      history: "Visit History",
      products: "Products",
    };
    document.getElementById("tableViewTitle").textContent = titles[view] || "";

    // Contextual "Add" button — only on the list views that have a
    // create action; wired to the matching modal via currentTableView.
    const addBtn = document.getElementById("tableAddBtn");
    const addLabels = { clients: "Add Client", delegates: "Add Delegate" };
    const addLabel = addLabels[view];
    addBtn.classList.toggle("hidden", !addLabel);
    addBtn.classList.toggle("flex", !!addLabel);
    if (addLabel) document.getElementById("tableAddBtnLabel").textContent = addLabel;

    // Gear icon now shows on every table (Columns applies everywhere);
    // Import/Export and Delete inside its menu stay Clients-only —
    // bulk roster operations don't make sense for Delegates/History/
    // Products.
    const settingsBtn = document.getElementById("tableSettingsBtn");
    settingsBtn.classList.remove("hidden");
    settingsBtn.classList.add("flex");
    const clientsOnly = view === "clients";
    document.getElementById("tableSettingsImportExportBtn").classList.toggle("hidden", !clientsOnly);
    document.getElementById("tableSettingsDeleteBtn").classList.toggle("hidden", !clientsOnly);
    document.getElementById("tableSettingsMenu").classList.add("hidden");
    document.getElementById("tableColumnsPanel").classList.add("hidden");

    const delegateFilter = document.getElementById("tableDelegateFilter");
    const statusFilter = document.getElementById("tableStatusFilter");
    const dateFrom = document.getElementById("tableDateFrom");
    const dateTo = document.getElementById("tableDateTo");
    const showArchivedWrap = document.getElementById("tableShowArchivedWrap");
    const isHistory = view === "history";
    delegateFilter.classList.toggle("hidden", !isHistory);
    statusFilter.classList.toggle("hidden", !isHistory);
    dateFrom.classList.toggle("hidden", !isHistory);
    dateTo.classList.toggle("hidden", !isHistory);
    showArchivedWrap.classList.toggle("hidden", !isHistory);
    showArchivedWrap.classList.toggle("flex", isHistory);
    if (!isHistory) document.getElementById("tableShowArchived").checked = false;

    if (isHistory && !delegateOptionsLoaded) {
      const delegates = await callApi("list_delegates", {});
      delegateFilter.innerHTML = '<option value="">All Delegates</option>';
      delegates.forEach((d) => {
        const opt = document.createElement("option");
        opt.value = d.name;
        opt.textContent = d.full_name;
        delegateFilter.appendChild(opt);
      });
      delegateOptionsLoaded = true;
    }

    await loadCurrentTableView();
  }

  let tableRequestId = 0;

  async function loadCurrentTableView() {
    if (!currentTableView) return;

    // Snapshot which view/request this call belongs to. If the user
    // switches views again before this resolves, we discard the
    // result instead of rendering it over whatever's now current —
    // this is what was causing Delegates data to overwrite Visit
    // History after the fact.
    const requestId = ++tableRequestId;
    const viewAtRequestTime = currentTableView;
    const txt = document.getElementById("tableSearchInput").value;

    let headers, rows;
    // Per-row metadata for clickable rows. Each entry is
    // { kind, id }: "visit" opens the visit detail modal, "customer"
    // the client detail modal, "delegate" the edit-delegate modal.
    // Views without metadata render as plain, non-interactive rows.
    let meta = null;

    if (viewAtRequestTime === "clients") {
      // One row per Point of Contact (a specialist), not per
      // organization — see list_client_contacts in api.py. No
      // per-row Delete anymore: check the rows you want gone and use
      // Gear -> Delete instead (bulk_delete_client_contacts), the
      // same selection Export already uses — one place for both bulk
      // actions instead of a button on every row.
      const data = await callApi("list_client_contacts", { txt });
      const activeCols = activeColumnDefs("clients", CLIENT_COLUMN_DEFS);
      headers = activeCols.map((c) => c.label);
      // kind "contact" (not "customer") — the row selection this
      // feeds (selectableIdsInView, export/delete scoping) is
      // Contact-scoped now: checking one specialist's row shouldn't
      // pull in every other specialist at the same organization. Also
      // means handleRowClick's "customer" branch no longer matches
      // here, so clicking a row is a no-op for now rather than
      // opening the wrong kind of record.
      meta = data.map((r) => ({ kind: "contact", id: r.contact }));
      rows = data.map((r) => activeCols.map((c) => c.get(r)));
    } else if (viewAtRequestTime === "delegates") {
      const data = await callApi("list_delegates", {});
      const filtered = txt
        ? data.filter((r) => r.full_name.toLowerCase().includes(txt.toLowerCase()))
        : data;
      const activeCols = activeColumnDefs("delegates", DELEGATE_COLUMN_DEFS);
      headers = [...activeCols.map((c) => c.label), "Actions"];
      meta = filtered.map((r) => ({ kind: "delegate", id: r.name }));
      rows = filtered.map((r) => [
        ...activeCols.map((c) => c.get(r)),
        {
          html:
            // Reassign — Regional-Manager-only, and only for a plain
            // field delegate (a manager owns their own brands, so has no
            // manager to move them under). The server re-checks both
            // (reassign_delegate); this just keeps the action off rows it
            // could never apply to.
            (window.IS_REGIONAL_MANAGER && r.role === "Delegate"
              ? `<button type="button" class="reassign-delegate-btn text-primary hover:underline font-label-md mr-sm" data-no-row-click data-delegate="${escapeHtml(r.name)}" data-name="${escapeHtml(r.full_name)}" data-manager="${escapeHtml(r.manager || "")}">Reassign</button>`
              : "") +
            `<button type="button" class="delete-delegate-btn text-error hover:underline font-label-md" data-no-row-click data-delegate="${escapeHtml(r.name)}" data-name="${escapeHtml(r.full_name)}">Delete</button>`,
        },
      ]);
    } else if (viewAtRequestTime === "products") {
      const data = await callApi("list_products", { txt });
      const items = data.products || [];
      const days = data.window_days;
      const activeCols = activeColumnDefs("products", productColumnDefs(days));
      headers = activeCols.map((c) => c.label);
      // Rows aren't clickable: an Item has no MedvisitPro-side detail
      // modal, and linking into Desk would need permissions the
      // Delegate Manager role deliberately doesn't have.
      rows = items.map((r) => activeCols.map((c) => c.get(r)));
    } else if (viewAtRequestTime === "history") {
      const delegate = document.getElementById("tableDelegateFilter").value;
      const status = document.getElementById("tableStatusFilter").value;
      const date_from = document.getElementById("tableDateFrom").value;
      const date_to = document.getElementById("tableDateTo").value;
      const include_archived = document.getElementById("tableShowArchived").checked;
      const data = await callApi("list_visits", { txt, delegate, status, date_from, date_to, include_archived });
      const activeCols = activeColumnDefs("history", HISTORY_COLUMN_DEFS);
      headers = [...activeCols.map((c) => c.label), "Actions"];
      meta = data.map((r) => ({ kind: "visit", id: r.name }));
      rows = data.map((r) => [
        ...activeCols.map((c) => c.get(r)),
        {
          html: r.archived
            ? (window.IS_REGIONAL_MANAGER
              ? `<button type="button" class="restore-visit-btn text-primary hover:underline font-label-md" data-no-row-click data-visit="${escapeHtml(r.name)}">Restore</button>`
              : '<span class="text-on-surface-variant">—</span>')
            : `<button type="button" class="archive-visit-btn text-error hover:underline font-label-md" data-no-row-click data-visit="${escapeHtml(r.name)}">Archive</button>`,
        },
      ]);
    } else {
      return;
    }

    // Stale response check — a newer request has started, or the
    // user switched to a different view entirely. Drop this result.
    if (requestId !== tableRequestId || currentTableView !== viewAtRequestTime) return;

    renderTable(headers, rows, meta);
  }

  // Share of visits where discussing this product produced an order.
  // Banded rather than shaded continuously so the eye can group them:
  // converting, patchy, or discussed-but-never-ordered.
  function conversionBadge(percent) {
    const tone =
      percent >= 50 ? "bg-secondary-container text-on-secondary-container"
      : percent > 0 ? "bg-tertiary-fixed text-on-tertiary-fixed"
      : "bg-error-container text-on-error-container";
    return `<span class="inline-block px-2 py-0.5 rounded-full font-label-sm text-label-sm ${tone}">${percent}%</span>`;
  }

  function renderTable(headers, rows, meta) {
    const headersKey = headers.join("|");
    if (headersKey !== lastTableHeadersKey) {
      tableSortCol = null;
      tableSortDir = "asc";
      lastTableHeadersKey = headersKey;
    }
    tableHeaders = headers;
    tableRows = rows;
    tableRowMeta = meta || [];
    applyTableSort();
    tablePage = 1;
    renderTablePage();
  }

  // A column is sortable when none of its cells is a rendered-HTML
  // object (badges, links, action buttons) — there's no single plain
  // value to compare those on.
  function isSortableColumn(colIndex) {
    return tableRows.every((row) => !(row[colIndex] && typeof row[colIndex] === "object"));
  }

  function applyTableSort() {
    if (tableSortCol === null || tableSortCol >= tableHeaders.length) return;
    if (!isSortableColumn(tableSortCol)) return;

    const dir = tableSortDir === "desc" ? -1 : 1;
    const order = tableRows.map((_, i) => i);
    order.sort((a, b) => {
      const av = tableRows[a][tableSortCol];
      const bv = tableRows[b][tableSortCol];
      const an = parseFloat(av);
      const bn = parseFloat(bv);
      const bothNumeric = av !== "—" && bv !== "—" && !Number.isNaN(an) && !Number.isNaN(bn);
      const cmp = bothNumeric
        ? an - bn
        : String(av ?? "").localeCompare(String(bv ?? ""), undefined, { sensitivity: "base" });
      return cmp * dir;
    });
    tableRows = order.map((i) => tableRows[i]);
    tableRowMeta = order.map((i) => tableRowMeta[i] || null);
  }

  // Every Customer record name currently matching the table's filters
  // (search etc.) — i.e. everything a "select all" should cover, not
  // just the visible page. Only meaningful on the Clients view; kind
  // distinguishes a customer row's meta from a delegate/visit row's.
  function selectableIdsInView() {
    return tableRowMeta.filter((m) => m && m.kind === "contact").map((m) => m.id);
  }

  // ---------- List / Board (Kanban) view mode ----------
  // Generic across every table view — driven entirely by the same
  // tableHeaders/tableRows/tableRowMeta List mode already builds, so
  // a future view gets Board mode for free just by existing in this
  // shared renderer. Persists per view (mvp-viewmode-<view>).
  let tableViewMode = "list";

  function loadViewMode(viewKey) {
    return localStorage.getItem("mvp-viewmode-" + viewKey) === "kanban" ? "kanban" : "list";
  }
  function saveViewMode(viewKey, mode) {
    localStorage.setItem("mvp-viewmode-" + viewKey, mode);
  }

  // Which column each view's board is grouped by, matched by header
  // label (not index — column visibility can shift indices). Falls
  // back to a single "All" group if that column's been hidden via the
  // Columns picker.
  const KANBAN_GROUP_LABEL = {
    clients: "Class",
    delegates: "Role",
    history: "Status",
    products: "Group",
  };

  // Plain text out of a cell, whether it's a raw value or a
  // {html: ...} badge/link — used for grouping and for cards, where a
  // "Completed" badge's markup isn't a useful group key, its text is.
  function cellText(cell) {
    if (cell && typeof cell === "object" && "html" in cell) {
      const div = document.createElement("div");
      div.innerHTML = cell.html;
      return (div.textContent || "").trim();
    }
    return String(cell ?? "");
  }

  function renderKanbanBoard() {
    const board = document.getElementById("tableKanbanBoard");
    const emptyState = document.getElementById("tableEmptyState");
    document.getElementById("tablePagination").classList.add("hidden");
    document.getElementById("tablePagination").classList.remove("flex");
    board.innerHTML = "";

    if (!tableRows.length) {
      emptyState.classList.remove("hidden");
      return;
    }
    emptyState.classList.add("hidden");

    const groupLabel = KANBAN_GROUP_LABEL[currentTableView];
    const groupColIdx = groupLabel ? tableHeaders.indexOf(groupLabel) : -1;
    const lastIsActions = tableHeaders[tableHeaders.length - 1] === "Actions";
    const fieldEnd = lastIsActions ? tableHeaders.length - 1 : tableHeaders.length;
    const selectableView = currentTableView === "clients";

    // Group rows, keeping first-seen order of group values rather than
    // alphabetising — Pending/Completed/Missed reading in that order
    // is a workflow, not a word list.
    const groups = new Map();
    tableRows.forEach((row, i) => {
      const key = groupColIdx >= 0 ? (cellText(row[groupColIdx]) || "—") : "All";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    });

    groups.forEach((indices, groupName) => {
      const col = document.createElement("div");
      col.className = "flex-shrink-0 w-72 bg-surface-container-low rounded-xl p-sm space-y-sm";
      col.innerHTML =
        `<div class="flex items-center justify-between px-xs py-1">` +
        `<span class="font-label-lg text-label-lg text-on-surface">${escapeHtml(groupName)}</span>` +
        `<span class="font-label-sm text-label-sm text-on-surface-variant bg-surface-container-lowest px-2 py-0.5 rounded-full">${indices.length}</span>` +
        `</div>`;

      const cardsWrap = document.createElement("div");
      cardsWrap.className = "space-y-sm max-h-[70vh] overflow-y-auto";

      indices.forEach((i) => {
        const row = tableRows[i];
        const rowMeta = tableRowMeta[i];
        const card = document.createElement("div");
        card.className = "bg-surface-container-lowest rounded-lg border border-outline-variant p-sm ambient-shadow";
        if (rowMeta && rowMeta.kind) card.classList.add("cursor-pointer", "hover:border-primary");

        const checkbox = selectableView && rowMeta
          ? `<input type="checkbox" class="client-select-checkbox rounded border-outline-variant text-primary focus:ring-primary float-right" data-no-row-click data-id="${escapeHtml(rowMeta.id)}" ${selectedClientIds.has(rowMeta.id) ? "checked" : ""}>`
          : "";

        // Column 0 is the card's title (the identifying value —
        // Specialist/Name/Client/Product); the rest render as label:
        // value lines, skipping the grouping column (already this
        // column's heading). Actions, if present, render full-width
        // beneath, same as the list view's own Actions cell.
        const fields = [];
        for (let c = 1; c < fieldEnd; c++) {
          if (c === groupColIdx) continue;
          const val = row[c] && typeof row[c] === "object" && "html" in row[c] ? row[c].html : escapeHtml(String(row[c]));
          fields.push(`<p class="font-body-sm text-body-sm text-on-surface-variant truncate"><span class="text-on-surface">${escapeHtml(tableHeaders[c])}:</span> ${val}</p>`);
        }
        const actionsHtml = lastIsActions && row[fieldEnd] && row[fieldEnd].html
          ? `<div class="mt-xs pt-xs border-t border-outline-variant" data-no-row-click>${row[fieldEnd].html}</div>`
          : "";

        card.innerHTML =
          checkbox +
          `<p class="font-label-md text-label-md text-on-surface mb-1">${escapeHtml(cellText(row[0]))}</p>` +
          fields.join("") +
          actionsHtml;

        if (rowMeta && rowMeta.kind) {
          card.addEventListener("click", (e) => {
            if (e.target.closest("a")) return;
            if (e.target.closest("[data-no-row-click]")) return;
            handleRowClick(rowMeta);
          });
        }
        cardsWrap.appendChild(card);
      });

      col.appendChild(cardsWrap);
      board.appendChild(col);
    });

    wireSelectionCheckboxes();
    updateSelectionUI();
  }

  // Dispatches to List or Board — every existing call site (sort
  // clicks, pagination, checkbox toggles) already calls this name, so
  // Board mode needed no changes anywhere else.
  function renderTablePage() {
    const kanban = tableViewMode === "kanban";
    document.getElementById("tableListWrap").classList.toggle("hidden", kanban);
    document.getElementById("tableKanbanWrap").classList.toggle("hidden", !kanban);
    if (kanban) {
      renderKanbanBoard();
    } else {
      renderListTable();
    }
  }

  // Renders the current page of tableRows plus the pager controls.
  function renderListTable() {
    const thead = document.getElementById("tableHead");
    const tbody = document.getElementById("tableBody");
    const emptyState = document.getElementById("tableEmptyState");
    const pagination = document.getElementById("tablePagination");
    // Row selection only applies to the Client List — Delegates and
    // Visit History have no export-by-selection feature.
    const selectable = currentTableView === "clients";

    const checkboxHead = selectable
      ? '<th class="w-8 py-2.5 pr-sm"><input type="checkbox" id="tableSelectAllCheckbox" ' +
        'class="rounded border-outline-variant text-primary focus:ring-primary" ' +
        'aria-label="Select all points of contact"></th>'
      : "";
    thead.innerHTML =
      `<tr>${checkboxHead}${tableHeaders
        .map((h, i) => {
          const sortable = isSortableColumn(i);
          if (!sortable) {
            return `<th class="py-2.5 pr-md font-label-md text-on-surface-variant">${escapeHtml(h)}</th>`;
          }
          const active = tableSortCol === i;
          // Plain characters, not a material-symbols-outlined icon —
          // "arrow_upward"/"arrow_downward"/"unfold_more" aren't in the
          // app's curated icon subset (see styles/README.md's "Adding
          // an icon"), so they'd render as literal ligature text
          // instead of glyphs without a font rebuild.
          const icon = active ? (tableSortDir === "asc" ? "▲" : "▼") : "⇅";
          return (
            `<th class="py-2.5 pr-md font-label-md text-on-surface-variant cursor-pointer select-none hover:text-on-surface" data-sort-col="${i}">` +
            `<span class="inline-flex items-center gap-0.5">${escapeHtml(h)}` +
            `<span class="text-[10px] ${active ? "text-primary" : "text-outline"}">${icon}</span>` +
            `</span></th>`
          );
        })
        .join("")}</tr>`;
    tbody.innerHTML = "";

    if (tableRows.length === 0) {
      emptyState.classList.remove("hidden");
      pagination.classList.add("hidden");
      pagination.classList.remove("flex");
      updateSelectionUI();
      return;
    }
    emptyState.classList.add("hidden");

    const totalPages = Math.ceil(tableRows.length / TABLE_PAGE_SIZE);
    tablePage = Math.min(Math.max(tablePage, 1), totalPages);
    const startIdx = (tablePage - 1) * TABLE_PAGE_SIZE;
    const pageRows = tableRows.slice(startIdx, startIdx + TABLE_PAGE_SIZE);

    pageRows.forEach((row, i) => {
      const tr = document.createElement("tr");
      tr.className = "border-b border-outline-variant last:border-0";

      const rowMeta = tableRowMeta[startIdx + i];
      const checkboxCell =
        selectable && rowMeta
          ? `<td class="py-2.5 pr-sm" data-no-row-click><input type="checkbox" ` +
            `class="client-select-checkbox rounded border-outline-variant text-primary focus:ring-primary" ` +
            `data-id="${escapeHtml(rowMeta.id)}" ${selectedClientIds.has(rowMeta.id) ? "checked" : ""}></td>`
          : selectable
            ? '<td class="py-2.5 pr-sm"></td>'
            : "";

      tr.innerHTML =
        checkboxCell +
        row
          .map((cell) => {
            const content = cell && typeof cell === "object" && "html" in cell ? cell.html : escapeHtml(String(cell));
            return `<td class="py-2.5 pr-md text-on-surface">${content}</td>`;
          })
          .join("");

      // Clickable row → open the matching detail/edit modal. Guarded so
      // a click on a link (e.g. "View on Map") or the checkbox itself
      // follows/toggles instead of also opening the modal.
      if (rowMeta && rowMeta.kind) {
        tr.classList.add("cursor-pointer", "hover:bg-surface-container-low");
        tr.addEventListener("click", (e) => {
          if (e.target.closest("a")) return;
          if (e.target.closest("[data-no-row-click]")) return;
          handleRowClick(rowMeta);
        });
      }
      tbody.appendChild(tr);
    });

    wireSelectionCheckboxes();
    updateSelectionUI();

    // Only show the pager when there's more than one page.
    if (totalPages <= 1) {
      pagination.classList.add("hidden");
      pagination.classList.remove("flex");
      return;
    }
    pagination.classList.remove("hidden");
    pagination.classList.add("flex");
    document.getElementById("tablePaginationInfo").textContent =
      `Showing ${startIdx + 1}–${startIdx + pageRows.length} of ${tableRows.length}`;
    document.getElementById("tablePageIndicator").textContent = `Page ${tablePage} of ${totalPages}`;
    document.getElementById("tablePrevBtn").disabled = tablePage <= 1;
    document.getElementById("tableNextBtn").disabled = tablePage >= totalPages;
  }

  // Wires the per-row checkboxes and the header "select all" freshly
  // inserted by renderTablePage. Re-run on every render since the
  // elements themselves are recreated each time.
  function wireSelectionCheckboxes() {
    document.querySelectorAll(".client-select-checkbox").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) selectedClientIds.add(cb.dataset.id);
        else selectedClientIds.delete(cb.dataset.id);
        updateSelectionUI();
      });
    });

    const selectAll = document.getElementById("tableSelectAllCheckbox");
    if (!selectAll) return;
    selectAll.addEventListener("change", () => {
      const ids = selectableIdsInView();
      if (selectAll.checked) ids.forEach((id) => selectedClientIds.add(id));
      else ids.forEach((id) => selectedClientIds.delete(id));
      // Re-render: the "select all" toggles rows beyond the current
      // page too, and each page's checkboxes need to reflect that.
      renderTablePage();
    });
  }

  // Keeps the select-all checkbox's checked/indeterminate state and the
  // gear-panel's "N selected" indicator in sync with selectedClientIds.
  // Called after every render and every individual checkbox toggle.
  function updateSelectionUI() {
    const selectAll = document.getElementById("tableSelectAllCheckbox");
    if (selectAll) {
      const ids = selectableIdsInView();
      const selectedHere = ids.filter((id) => selectedClientIds.has(id)).length;
      selectAll.checked = ids.length > 0 && selectedHere === ids.length;
      selectAll.indeterminate = selectedHere > 0 && selectedHere < ids.length;
    }
    refreshExportScopeLabel();
    updateTableSettingsDeleteState();
  }

  // Gear -> Delete only makes sense once something's checked — greyed
  // out otherwise rather than letting it be clicked into an empty
  // selection error.
  function updateTableSettingsDeleteState() {
    const btn = document.getElementById("tableSettingsDeleteBtn");
    if (btn) btn.disabled = selectedClientIds.size === 0;
  }

  function changeTablePage(delta) {
    tablePage += delta;
    renderTablePage();
    document.getElementById("tableView").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- Visit Detail modal ----------
  function openVisitDetailModal() {
    const modal = document.getElementById("visitDetailModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }

  function closeVisitDetailModal() {
    const modal = document.getElementById("visitDetailModal");
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }

  // Remembered so the "Confirm Order" action can re-fetch and re-render
  // the same visit after it mutates the linked order.
  let currentDetailAssignment = null;

  async function openVisitDetail(assignment) {
    currentDetailAssignment = assignment;
    const body = document.getElementById("visitDetailBody");
    body.innerHTML = `<p class="text-body-sm text-on-surface-variant py-md">Loading visit details…</p>`;
    openVisitDetailModal();
    try {
      const d = await callApi("get_visit_details", { assignment });
      body.innerHTML = renderVisitDetail(d);
      wireVisitDetailActions(d);
    } catch (err) {
      body.innerHTML = `<p class="text-body-sm text-error py-md">${escapeHtml(err.message || "Could not load visit details.")}</p>`;
    }
  }

  function wireVisitDetailActions(d) {
    const btn = document.getElementById("confirmOrderBtn");
    if (btn && d.visit && d.visit.order) {
      btn.addEventListener("click", () => confirmOrder(d.visit.order.name, btn));
    }
  }

  async function confirmOrder(salesOrder, btn) {
    btn.disabled = true;
    btn.textContent = "Confirming…";
    try {
      const res = await callApi("confirm_sales_order", { sales_order: salesOrder });
      if (res && res.ok === false) {
        if (window.MedvisitPro) MedvisitPro.showToast(res.error || "Could not confirm order.", "error");
        btn.disabled = false;
        btn.textContent = "Confirm Order";
        return;
      }
      if (window.MedvisitPro) MedvisitPro.showToast("Order confirmed.", "success");
      // Re-render the modal so the order now shows as confirmed.
      if (currentDetailAssignment) openVisitDetail(currentDetailAssignment);
    } catch (err) {
      if (window.MedvisitPro) MedvisitPro.showToast(err.message || "Could not confirm order.", "error");
      btn.disabled = false;
      btn.textContent = "Confirm Order";
    }
  }

  // Renders the linked Sales Order: status, line items, total, a link
  // to the full record, and a Confirm button while it's still a draft.
  function renderOrderBlock(order) {
    const money = (n) => (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const cur = order.currency ? order.currency + " " : "";
    const chip = order.is_confirmed
      ? `<span class="text-secondary font-label-md">Confirmed</span>`
      : order.is_draft
        ? `<span class="text-amber-600 font-label-md">Draft — awaiting confirmation</span>`
        : `<span class="text-on-surface-variant font-label-md">${escapeHtml(order.status || "")}</span>`;

    const rows = (order.items || []).map((it) =>
      `<div class="flex justify-between gap-sm text-body-sm">
        <span class="text-on-surface truncate">${escapeHtml(it.item_name || it.item_code)} <span class="text-on-surface-variant">× ${money(it.qty)}</span></span>
        <span class="text-on-surface-variant whitespace-nowrap">${cur}${money(it.amount)}</span>
      </div>`).join("");

    let html = `<div class="border-t border-outline-variant pt-md mb-md">
      <div class="flex items-center justify-between mb-xs">
        <span class="font-label-md text-label-md text-on-surface-variant flex items-center gap-1">
          <span class="material-symbols-outlined text-[18px]">shopping_cart</span> Order
        </span>
        ${chip}
      </div>
      <div class="space-y-xs mb-sm">${rows || '<span class="text-body-sm text-on-surface-variant">No line items.</span>'}</div>
      <div class="flex justify-between items-center pt-xs border-t border-outline-variant">
        <span class="font-label-md text-label-md text-on-surface">Total</span>
        <span class="font-headline-md text-headline-md text-primary">${cur}${money(order.grand_total)}</span>
      </div>
      <div class="flex items-center gap-md mt-sm">
        <a href="/app/sales-order/${encodeURIComponent(order.name)}" target="_blank" rel="noopener" class="text-primary hover:underline text-label-sm">${escapeHtml(order.name)}</a>`;
    if (order.is_draft) {
      html += `<button type="button" id="confirmOrderBtn" class="ml-auto px-md py-1.5 bg-primary text-on-primary rounded-lg font-label-md text-label-md">Confirm Order</button>`;
    }
    html += `</div></div>`;
    return html;
  }

  function detailField(label, valueHtml) {
    return `<div class="flex flex-col gap-0.5">
      <span class="font-label-sm text-label-sm text-on-surface-variant">${escapeHtml(label)}</span>
      <span class="font-body-md text-body-md text-on-surface">${valueHtml}</span>
    </div>`;
  }

  // Address (if reverse-geocoded) + a map link, with accuracy and an
  // "(approx.)" flag when the source wasn't a real GPS fix — same
  // caveats the history table's location column already shows.
  function detailLocationHtml(v) {
    if (!v.checkin_latitude || !v.checkin_longitude) {
      return `<span class="text-on-surface-variant">Not captured</span>`;
    }
    const url = `https://www.google.com/maps?q=${v.checkin_latitude},${v.checkin_longitude}`;
    const approx = v.checkin_location_source && v.checkin_location_source !== "GPS";
    let out = "";
    if (v.checkin_address) out += `${escapeHtml(v.checkin_address)}<br>`;
    out += `<a href="${url}" target="_blank" rel="noopener" class="text-primary hover:underline inline-flex items-center gap-1">
      <span class="material-symbols-outlined text-[16px]">location_on</span>View on Map</a>`;
    if (v.checkin_accuracy) out += ` <span class="text-label-sm text-on-surface-variant">(±${Math.round(v.checkin_accuracy)}m)</span>`;
    if (approx) out += ` <span class="text-label-sm text-amber-600" title="Network-based location — may be inaccurate">(approx.)</span>`;
    return out;
  }

  function renderVisitDetail(d) {
    const typeSuffix = d.visit_type === "Ad-hoc" ? ` · <span class="italic">ad-hoc</span>` : "";
    let html = `
      <div class="flex items-start justify-between gap-md mb-md">
        <div>
          <h3 class="font-headline-md text-headline-md text-on-surface">${escapeHtml(d.customer_name)}</h3>
          <p class="font-body-sm text-body-sm text-on-surface-variant">${escapeHtml(d.delegate_name)}${typeSuffix}</p>
        </div>
        <div>${statusBadge(d.status)}</div>
      </div>
      <div class="grid grid-cols-2 gap-md mb-md">
        ${detailField("Scheduled Date", escapeHtml(d.scheduled_date || "—"))}
        ${detailField("Scheduled Time", escapeHtml(d.scheduled_time || "—"))}
        ${detailField("Point of Contact", escapeHtml(d.contact_person_name || "—"))}
      </div>`;

    const v = d.visit;
    if (!v) {
      html += `<div class="bg-surface-container p-md rounded-lg text-body-sm text-on-surface-variant">
        No visit has been logged for this assignment yet${d.status ? ` — it is currently <strong>${escapeHtml(d.status)}</strong>.` : "."}
      </div>`;
      return html;
    }

    html += `<div class="border-t border-outline-variant pt-md grid grid-cols-2 gap-md mb-md">
      ${detailField("Outcome", escapeHtml(v.outcome || "—"))}
      ${detailField("Check-in Time", escapeHtml(v.checkin_time || "—"))}
    </div>`;

    html += `<div class="mb-md">${detailField("Check-in Location", detailLocationHtml(v))}</div>`;

    const notesHtml = v.discussion_notes
      ? escapeHtml(v.discussion_notes).replace(/\n/g, "<br>")
      : `<span class="text-on-surface-variant">—</span>`;
    html += `<div class="mb-md">${detailField("Discussion Notes", notesHtml)}</div>`;

    let productsHtml;
    if (v.products && v.products.length) {
      productsHtml = `<ul class="mt-xs space-y-xs">` + v.products.map((p) =>
        `<li class="flex items-start gap-sm text-body-md">
          <span class="material-symbols-outlined text-[18px] text-primary">medication</span>
          <span><span class="text-on-surface">${escapeHtml(p.item_name)}</span>${
            p.remarks ? `<span class="text-on-surface-variant"> — ${escapeHtml(p.remarks)}</span>` : ""
          }</span>
        </li>`).join("") + `</ul>`;
    } else {
      productsHtml = `<p class="text-body-md text-on-surface-variant mt-xs">—</p>`;
    }
    html += `<div class="mb-md">
      <span class="font-label-sm text-label-sm text-on-surface-variant">Products Discussed</span>
      ${productsHtml}
    </div>`;

    if (v.order) {
      html += renderOrderBlock(v.order);
    }

    html += `<p class="font-label-sm text-label-sm text-on-surface-variant mt-sm pt-sm border-t border-outline-variant">Record: ${escapeHtml(v.name)}</p>`;
    return html;
  }

  // Dispatches a clickable table row to the right modal by its kind.
  function handleRowClick(meta) {
    if (meta.kind === "visit") openVisitDetail(meta.id);
    else if (meta.kind === "customer") openCustomerDetail(meta.id);
    else if (meta.kind === "delegate") openDelegateEdit(meta.id);
  }

  // ---------- Client Detail modal (read-only) ----------
  function openClientDetailModal() {
    const modal = document.getElementById("clientDetailModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }

  function closeClientDetailModal() {
    const modal = document.getElementById("clientDetailModal");
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }

  async function openCustomerDetail(customer) {
    const body = document.getElementById("clientDetailBody");
    body.innerHTML = `<p class="text-body-sm text-on-surface-variant py-md">Loading client details…</p>`;
    openClientDetailModal();
    try {
      const d = await callApi("get_customer_details", { customer });
      body.innerHTML = renderCustomerDetail(d);
      wireCustomerDetailActions(d);
    } catch (err) {
      body.innerHTML = `<p class="text-body-sm text-error py-md">${escapeHtml(err.message || "Could not load client details.")}</p>`;
    }
  }

  // ---------- Client Detail: assignment, geography, points of contact ----------

  let provinceDistrictCache = null;
  async function ensureProvinceDistrictCache() {
    if (!provinceDistrictCache) provinceDistrictCache = await callApi("list_provinces_districts", {});
    return provinceDistrictCache;
  }

  function populateDistrictSelect(select, province, selected) {
    const districts = (provinceDistrictCache && provinceDistrictCache[province]) || [];
    select.innerHTML = '<option value="">—</option>' +
      districts.map((d) => `<option value="${escapeHtml(d)}"${d === selected ? " selected" : ""}>${escapeHtml(d)}</option>`).join("");
    select.disabled = !province;
  }

  function pointOfContactRow(c) {
    return `
      <div class="flex items-center justify-between gap-sm py-xs border-b border-outline-variant last:border-0" data-contact="${escapeHtml(c.name)}">
        <div class="min-w-0">
          <p class="font-label-md text-label-md text-on-surface truncate">${escapeHtml(c.display_name)}</p>
          <p class="font-body-sm text-body-sm text-on-surface-variant truncate">${escapeHtml(c.designation || "—")}${c.phone ? " · " + escapeHtml(c.phone) : ""}</p>
        </div>
        <div class="flex items-center gap-xs flex-shrink-0">
          <button type="button" class="contact-edit-btn text-primary hover:opacity-70 flex items-center" data-contact="${escapeHtml(c.name)}" title="Edit">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.9959.9959 0 0 0 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          </button>
          <button type="button" class="contact-delete-btn material-symbols-outlined text-[18px] text-on-surface-variant hover:text-error" data-contact="${escapeHtml(c.name)}" title="Remove">delete</button>
        </div>
      </div>`;
  }

  function wireCustomerDetailActions(d) {
    ensureProvinceDistrictCache().then(() => {
      const provinceSel = document.getElementById("clientDetailProvince");
      const districtSel = document.getElementById("clientDetailDistrict");
      if (!provinceSel) return;
      Object.keys(provinceDistrictCache).forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p;
        opt.textContent = p;
        if (p === d.province) opt.selected = true;
        provinceSel.appendChild(opt);
      });
      populateDistrictSelect(districtSel, d.province, d.district);
      provinceSel.addEventListener("change", () => populateDistrictSelect(districtSel, provinceSel.value, null));
    });

    const saveGeoBtn = document.getElementById("saveClientGeoBtn");
    if (saveGeoBtn) {
      saveGeoBtn.addEventListener("click", async () => {
        saveGeoBtn.disabled = true;
        try {
          const result = await callApi("update_client_geo", {
            customer: d.customer,
            province: document.getElementById("clientDetailProvince").value || null,
            district: document.getElementById("clientDetailDistrict").value || null,
          });
          if (result.ok === false) throw new Error(result.error);
          if (window.MedvisitPro) MedvisitPro.showToast("Location saved.");
        } catch (err) {
          if (window.MedvisitPro) MedvisitPro.showToast(err.message || "Could not save location.", "error");
        } finally {
          saveGeoBtn.disabled = false;
        }
      });
    }

    // Assigned delegate: search-as-you-type, same pattern as Assign Visit.
    const searchInput = document.getElementById("clientDetailDelegateSearch");
    if (searchInput) {
      let t = null;
      searchInput.addEventListener("input", (e) => {
        clearTimeout(t);
        const txt = e.target.value;
        t = setTimeout(async () => {
          const results = await callApi("search_delegates", { txt });
          const box = document.getElementById("clientDetailDelegateResults");
          box.innerHTML = "";
          results.forEach((del) => {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "w-full text-left px-sm py-1 rounded-lg hover:bg-surface-container text-body-sm";
            row.textContent = del.full_name;
            row.addEventListener("click", async () => {
              box.innerHTML = "";
              searchInput.value = "";
              try {
                const result = await callApi("assign_client", { customer: d.customer, delegate: del.name });
                if (result.ok === false) throw new Error(result.error);
                document.getElementById("clientDetailAssignedLabel").textContent = "Assigned to: " + del.full_name;
                if (window.MedvisitPro) MedvisitPro.showToast(`Assigned to ${del.full_name}.`);
              } catch (err) {
                if (window.MedvisitPro) MedvisitPro.showToast(err.message || "Could not assign.", "error");
              }
            });
            box.appendChild(row);
          });
        }, 300);
      });
    }
    const unassignBtn = document.getElementById("clientDetailUnassignBtn");
    if (unassignBtn) {
      unassignBtn.addEventListener("click", async () => {
        try {
          await callApi("unassign_client", { customer: d.customer });
          document.getElementById("clientDetailAssignedLabel").textContent = "Not assigned.";
          if (window.MedvisitPro) MedvisitPro.showToast("Unassigned.");
        } catch (err) {
          if (window.MedvisitPro) MedvisitPro.showToast(err.message || "Could not unassign.", "error");
        }
      });
    }

    // Points of contact: add / edit / delete, refreshing the list in place.
    const contactList = document.getElementById("clientDetailContactList");
    async function refreshContacts() {
      const contacts = await callApi("get_customer_contacts", { customer: d.customer });
      contactList.innerHTML = contacts.length
        ? contacts.map(pointOfContactRow).join("")
        : '<p class="font-body-sm text-body-sm text-on-surface-variant py-xs">No points of contact yet.</p>';
      wireContactRowButtons();
    }
    function wireContactRowButtons() {
      contactList.querySelectorAll(".contact-delete-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          openConfirmModal({
            title: "Remove point of contact?",
            message: "This removes them from this client's roster. It can't be undone from here.",
            confirmLabel: "Remove",
            onConfirm: async () => {
              await callApi("delete_client_contact", { contact: btn.dataset.contact });
              refreshContacts();
            },
          });
        });
      });
      contactList.querySelectorAll(".contact-edit-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const row = contactList.querySelector(`[data-contact="${CSS.escape(btn.dataset.contact)}"]`);
          const name = row.querySelector("p").textContent;
          const [first, ...rest] = name.split(" ");
          document.getElementById("newContactId").value = btn.dataset.contact;
          document.getElementById("newContactFirstName").value = first || "";
          document.getElementById("newContactLastName").value = rest.join(" ");
          document.getElementById("newContactDesignation").value =
            row.querySelector("p:last-child").textContent.split(" · ")[0].replace("—", "");
          document.getElementById("newContactPhone").value = "";
          document.getElementById("addContactBtn").textContent = "Save Changes";
        });
      });
    }
    document.getElementById("addContactBtn").addEventListener("click", async () => {
      const btn = document.getElementById("addContactBtn");
      const editingId = document.getElementById("newContactId").value;
      const payload = {
        first_name: document.getElementById("newContactFirstName").value.trim(),
        last_name: document.getElementById("newContactLastName").value.trim() || null,
        designation: document.getElementById("newContactDesignation").value.trim() || null,
        phone: document.getElementById("newContactPhone").value.trim() || null,
      };
      if (!payload.first_name) {
        if (window.MedvisitPro) MedvisitPro.showToast("A name is required.", "error");
        return;
      }
      btn.disabled = true;
      try {
        const result = editingId
          ? await callApi("update_client_contact", { contact: editingId, ...payload })
          : await callApi("add_client_contact", { customer: d.customer, ...payload });
        if (result.ok === false) throw new Error(result.error);
        ["newContactId", "newContactFirstName", "newContactLastName", "newContactDesignation", "newContactPhone"]
          .forEach((id) => (document.getElementById(id).value = ""));
        btn.textContent = "Add";
        await refreshContacts();
        if (window.MedvisitPro) MedvisitPro.showToast(editingId ? "Contact updated." : "Contact added.");
      } catch (err) {
        if (window.MedvisitPro) MedvisitPro.showToast(err.message || "Could not save contact.", "error");
      } finally {
        btn.disabled = false;
      }
    });
    wireContactRowButtons();
  }

  function renderCustomerDetail(d) {
    const statusChip = d.enabled
      ? `<span class="text-secondary font-label-md">Active</span>`
      : `<span class="text-error font-label-md">Disabled</span>`;
    const fullAddress = [d.address_line1, d.city].filter(Boolean).join(", ");
    const lastVisit = d.last_visit ? d.last_visit.split(" ")[0] : "—";

    return `
      <div class="flex items-start justify-between gap-md mb-md">
        <div>
          <h3 class="font-headline-md text-headline-md text-on-surface">${escapeHtml(d.customer_name)}</h3>
          <p class="font-body-sm text-body-sm text-on-surface-variant">${escapeHtml(d.customer_category || "Uncategorized")}</p>
        </div>
        <div>${statusChip}</div>
      </div>
      <div class="grid grid-cols-2 gap-md mb-md">
        ${detailField("Type", escapeHtml(d.customer_type))}
        ${detailField("Phone", escapeHtml(d.phone || "—"))}
        ${detailField("Email", escapeHtml(d.email || "—"))}
        ${detailField("Client Class", escapeHtml(d.customer_class || "Unclassed"))}
        ${detailField("Expected Visits / Month", d.expected_visits_per_month ? String(d.expected_visits_per_month) : "—")}
      </div>
      <div class="mb-md">${detailField("Address", escapeHtml(fullAddress || "—"))}</div>

      <div class="border-t border-outline-variant pt-md mb-md">
        <h4 class="font-label-md text-label-md text-primary mb-sm">LOCATION</h4>
        <div class="grid grid-cols-2 gap-sm mb-sm">
          <select id="clientDetailProvince" class="p-sm rounded-lg border border-outline-variant outline-none focus:border-primary"><option value="">Province —</option></select>
          <select id="clientDetailDistrict" class="p-sm rounded-lg border border-outline-variant outline-none focus:border-primary"><option value="">District —</option></select>
        </div>
        <button type="button" id="saveClientGeoBtn" class="text-primary font-label-md hover:underline">Save Location</button>
      </div>

      <div class="border-t border-outline-variant pt-md mb-md">
        <h4 class="font-label-md text-label-md text-primary mb-sm">ASSIGNED DELEGATE</h4>
        <p class="font-body-sm text-body-sm text-on-surface-variant mb-xs" id="clientDetailAssignedLabel">
          ${d.assigned_delegate_name ? "Assigned to: " + escapeHtml(d.assigned_delegate_name) : "Not assigned."}
        </p>
        <div class="relative">
          <input id="clientDetailDelegateSearch" type="text" placeholder="Search delegates to assign…" autocomplete="off"
            class="w-full p-sm rounded-lg border border-outline-variant outline-none focus:border-primary">
          <div id="clientDetailDelegateResults" class="mt-xs"></div>
        </div>
        ${d.assigned_delegate ? '<button type="button" id="clientDetailUnassignBtn" class="mt-xs text-error font-label-md hover:underline">Unassign</button>' : ""}
      </div>

      <div class="border-t border-outline-variant pt-md">
        <h4 class="font-label-md text-label-md text-primary mb-sm">POINTS OF CONTACT</h4>
        <div id="clientDetailContactList" class="mb-sm">
          ${(d.contacts || []).length ? d.contacts.map(pointOfContactRow).join("") : '<p class="font-body-sm text-body-sm text-on-surface-variant py-xs">No points of contact yet.</p>'}
        </div>
        <input type="hidden" id="newContactId">
        <div class="grid grid-cols-2 gap-xs mb-xs">
          <input id="newContactFirstName" type="text" placeholder="First name" class="p-sm rounded-lg border border-outline-variant outline-none focus:border-primary">
          <input id="newContactLastName" type="text" placeholder="Last name" class="p-sm rounded-lg border border-outline-variant outline-none focus:border-primary">
        </div>
        <div class="grid grid-cols-2 gap-xs mb-xs">
          <input id="newContactDesignation" type="text" placeholder="Speciality (e.g. Cardiologist)" class="p-sm rounded-lg border border-outline-variant outline-none focus:border-primary">
          <input id="newContactPhone" type="tel" placeholder="Phone" class="p-sm rounded-lg border border-outline-variant outline-none focus:border-primary">
        </div>
        <button type="button" id="addContactBtn" class="w-full py-sm bg-primary text-on-primary rounded-lg font-label-md">Add</button>
      </div>

      <div class="border-t border-outline-variant pt-md mt-md grid grid-cols-2 gap-md">
        ${detailField("Total Visits Logged", String(d.total_visits))}
        ${detailField("Last Visit", escapeHtml(lastVisit))}
      </div>`;
  }

  // ---------- Edit Delegate modal ----------
  let editingDelegate = null;
  // Fallback for the "has manager access" state when the checkbox
  // itself isn't in the DOM (non-Regional-Manager viewer) — save must
  // still send the delegate's true current state, not a default.
  let editingDelegateIsManager = false;
  // The delegate's manager (medvisitpro_manager) as it was when the
  // modal opened, so save only calls reassign_delegate when it actually
  // changed. Regional-Manager-only — the picker isn't in the DOM otherwise.
  let editingDelegateManager = null;

  function closeEditDelegateModal() {
    const modal = document.getElementById("editDelegateModal");
    modal.classList.add("hidden");
    modal.classList.remove("flex");
    editingDelegate = null;
  }

  // ---------- Reassign Delegate modal (Regional-Manager-only) ----------
  // A focused, one-click alternative to the "Reports To" picker inside
  // the full Edit form — reachable straight from the Delegates table so
  // moving a delegate between managers is a visible, first-class action.
  let reassigningDelegate = null;
  let reassigningFromManager = null;

  function closeReassignDelegateModal() {
    const modal = document.getElementById("reassignDelegateModal");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.classList.remove("flex");
    reassigningDelegate = null;
  }

  async function openReassignDelegateModal(name, fullName, currentManager) {
    const modal = document.getElementById("reassignDelegateModal");
    if (!modal) return; // not a Regional Manager — modal isn't in the DOM
    reassigningDelegate = name;
    reassigningFromManager = currentManager || null;

    const errEl = document.getElementById("reassignDelegateError");
    errEl.classList.add("hidden");
    document.getElementById("reassignDelegateSubtitle").textContent =
      `Move ${fullName} to a different Delegate Manager.`;

    const sel = document.getElementById("reassignDelegateManager");
    try {
      if (!managerCache) managerCache = await callApi("list_delegate_managers", {});
    } catch (err) {
      if (window.MedvisitPro) MedvisitPro.showToast(err.message || "Could not load managers.", "error");
      return;
    }
    sel.innerHTML = '<option value="">— Select a manager —</option>' +
      managerCache.map((m) => `<option value="${escapeHtml(m.name)}"${m.name === currentManager ? " selected" : ""}>${escapeHtml(m.full_name || m.name)}</option>`).join("");

    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }

  async function confirmReassignDelegate() {
    const errEl = document.getElementById("reassignDelegateError");
    errEl.classList.add("hidden");
    const newManager = document.getElementById("reassignDelegateManager").value || null;

    if (!newManager) {
      errEl.textContent = "Pick a manager to assign this delegate to.";
      errEl.classList.remove("hidden");
      return;
    }
    if (newManager === reassigningFromManager) {
      errEl.textContent = "That's already this delegate's manager.";
      errEl.classList.remove("hidden");
      return;
    }

    const btn = document.getElementById("confirmReassignDelegateBtn");
    btn.disabled = true;
    btn.textContent = "Reassigning...";
    try {
      const result = await callApi("reassign_delegate", {
        delegate: reassigningDelegate,
        new_manager: newManager,
      });
      if (result && result.ok === false) {
        errEl.textContent = result.error || "Could not reassign this delegate.";
        errEl.classList.remove("hidden");
        if (window.MedvisitPro) MedvisitPro.showToast(errEl.textContent, "error");
        return;
      }
      closeReassignDelegateModal();
      if (window.MedvisitPro) MedvisitPro.showToast("Delegate reassigned.", "success");
      if (currentTableView === "delegates") loadCurrentTableView();
    } catch (err) {
      errEl.textContent = err.message || "Could not reassign this delegate.";
      errEl.classList.remove("hidden");
      if (window.MedvisitPro) MedvisitPro.showToast(errEl.textContent, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Reassign";
    }
  }

  let territoryCache = null;
  let brandCache = null;
  let managerCache = null;

  // Brands are only ever hand-edited for a Delegate Manager, and only
  // by a Regional Manager (_require_regional_manager in api.py) — a
  // plain delegate's brands mirror whoever created them and move only
  // when that manager's do (_sync_managed_delegates_brands). Everyone
  // else sees the current set as read-only chips with an explanation,
  // rather than a checklist that would silently do nothing on save.
  function renderEditDelegateBrands(d, alsoManagerChecked) {
    const container = document.getElementById("editDelegateBrandList");
    const note = document.getElementById("editDelegateBrandNote");
    const editable = window.IS_REGIONAL_MANAGER && alsoManagerChecked;

    if (editable) {
      container.innerHTML = brandCache.length
        ? brandCache.map((b) => `
            <label class="flex items-center gap-xs cursor-pointer">
              <input type="checkbox" class="edit-delegate-brand rounded border-outline-variant text-primary focus:ring-primary" value="${escapeHtml(b)}"${(d.brands || []).includes(b) ? " checked" : ""}>
              <span class="font-body-sm text-body-sm text-on-surface">${escapeHtml(b)}</span>
            </label>`).join("")
        : '<p class="font-body-sm text-body-sm text-on-surface-variant">No brands set up yet.</p>';
      note.textContent = "None checked = sees every brand.";
    } else {
      container.innerHTML = (d.brands || []).length
        ? `<p class="font-body-sm text-body-sm text-on-surface col-span-2">${(d.brands || []).map(escapeHtml).join(", ")}</p>`
        : '<p class="font-body-sm text-body-sm text-on-surface-variant col-span-2">All brands.</p>';
      note.textContent = alsoManagerChecked
        ? "Only a Regional Manager can change a Delegate Manager's brands."
        : "Inherited from this delegate's manager — edit the manager's brands to change it.";
    }
  }

  // Territory and an assigned-client portfolio are both field-coverage
  // concepts — they only mean anything for a Delegate actually visiting
  // clients. A Delegate Manager has neither: territory is cleared
  // server-side for one regardless of what this form submits (see
  // update_delegate in api.py), and search_delegates/assign_client now
  // exclude anyone carrying Delegate Manager from being assignable to
  // a client in the first place, so "View Assigned Clients" would only
  // ever show an empty roster for them.
  function updateTerritorySectionVisibility(isManager) {
    document.getElementById("editDelegateTerritorySection").classList.toggle("hidden", isManager);
    document.getElementById("editDelegateNoTerritoryNote").classList.toggle("hidden", !isManager);
    document.getElementById("viewDelegatePortfolioBtn").classList.toggle("hidden", isManager);
    // "Reports To" is a plain-delegate concept — a Delegate Manager owns
    // their own brands and reports to no one, so the picker is hidden the
    // moment "has manager access" is ticked (and it's Regional-Manager-only
    // in the DOM to begin with, hence the null-check).
    const managerSection = document.getElementById("editDelegateManagerSection");
    if (managerSection) managerSection.classList.toggle("hidden", isManager);
  }

  async function openDelegateEdit(name) {
    const errEl = document.getElementById("editDelegateError");
    errEl.classList.add("hidden");
    try {
      const d = await callApi("get_delegate", { name });
      editingDelegate = d.name;
      document.getElementById("editDelegateName").value = d.full_name || "";
      document.getElementById("editDelegateEmail").value = d.email || "";
      document.getElementById("editDelegateMobile").value = d.mobile_no || "";
      editingDelegateIsManager = !!d.is_manager;
      const alsoManagerEl = document.getElementById("editDelegateAlsoManager");
      if (alsoManagerEl) alsoManagerEl.checked = !!d.is_manager;
      document.getElementById("editDelegateEnabled").checked = d.enabled !== 0;
      document.getElementById("viewDelegatePortfolioCount").textContent =
        d.assigned_client_count ? ` (${d.assigned_client_count})` : "";

      if (!territoryCache) territoryCache = await callApi("list_territories", {});
      if (!brandCache) brandCache = await callApi("list_all_brands", {});

      // "Reports To" picker — Regional-Manager-only, so the <select> is
      // absent for everyone else and this whole block is skipped.
      editingDelegateManager = d.manager || null;
      const managerSel = document.getElementById("editDelegateManager");
      if (managerSel) {
        if (!managerCache) managerCache = await callApi("list_delegate_managers", {});
        // The delegate's current manager may be disabled (and so absent
        // from the pick list) — keep it as a selectable option so the
        // field still shows who they report to rather than blanking it.
        const options = managerCache.slice();
        if (d.manager && !options.some((m) => m.name === d.manager)) {
          options.push({ name: d.manager, full_name: d.manager_name || d.manager });
        }
        managerSel.innerHTML = '<option value="">—</option>' +
          options.map((m) => `<option value="${escapeHtml(m.name)}"${m.name === d.manager ? " selected" : ""}>${escapeHtml(m.full_name || m.name)}</option>`).join("");
      }

      const fillTerritory = (id, selected) => {
        const sel = document.getElementById(id);
        sel.innerHTML = '<option value="">—</option>' +
          territoryCache.map((t) => `<option value="${escapeHtml(t)}"${t === selected ? " selected" : ""}>${escapeHtml(t)}</option>`).join("");
      };
      fillTerritory("editDelegatePrimaryTerritory", d.primary_territory);
      fillTerritory("editDelegateSecondaryTerritory", d.secondary_territory);

      renderEditDelegateBrands(d, !!d.is_manager);
      updateTerritorySectionVisibility(!!d.is_manager);
      if (alsoManagerEl) {
        alsoManagerEl.onchange = () => {
          renderEditDelegateBrands(d, alsoManagerEl.checked);
          updateTerritorySectionVisibility(alsoManagerEl.checked);
        };
      }

      const modal = document.getElementById("editDelegateModal");
      modal.classList.remove("hidden");
      modal.classList.add("flex");
    } catch (err) {
      if (window.MedvisitPro) MedvisitPro.showToast(err.message || "Could not load this delegate.", "error");
    }
  }

  // ---------- Delegate Portfolio modal ----------

  function closeDelegatePortfolioModal() {
    const modal = document.getElementById("delegatePortfolioModal");
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }

  function portfolioRowHtml(row) {
    return `<tr class="border-b border-outline-variant last:border-0">
      <td class="py-2 px-sm text-on-surface">${escapeHtml(row.point_of_contact || "—")}</td>
      <td class="py-2 px-sm text-on-surface">${escapeHtml(row.organization)}</td>
      <td class="py-2 px-sm text-on-surface">${escapeHtml(row.speciality || "—")}</td>
      <td class="py-2 px-sm text-on-surface">${escapeHtml(row.customer_class)}</td>
      <td class="py-2 px-sm text-on-surface">${escapeHtml(row.province || "—")}</td>
      <td class="py-2 px-sm text-on-surface">${escapeHtml(row.district || "—")}</td>
      <td class="py-2 px-sm text-on-surface">${escapeHtml(row.phone || "—")}</td>
    </tr>`;
  }

  // Cached whenever the portfolio loads, so "Assign Responsible
  // Clients" (opened from this modal) knows who it's assigning for
  // and which territories are even available, without a second fetch.
  let currentPortfolioDelegate = null;

  async function openDelegatePortfolio(delegate) {
    const modal = document.getElementById("delegatePortfolioModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    document.getElementById("portfolioTableBody").innerHTML = "";
    document.getElementById("portfolioEmptyState").classList.add("hidden");
    document.getElementById("portfolioDelegateName").textContent = "Loading…";
    currentPortfolioDelegate = null;

    try {
      const p = await callApi("get_delegate_portfolio", { delegate });
      currentPortfolioDelegate = {
        name: delegate, full_name: p.full_name,
        primary_territory: p.primary_territory, secondary_territory: p.secondary_territory,
      };
      document.getElementById("portfolioDelegateName").textContent = p.full_name;
      const territoryText = [p.primary_territory, p.secondary_territory].filter(Boolean).join(" · ");
      const brandText = (p.brands || []).join(", ") || "All brands";
      document.getElementById("portfolioDelegateMeta").textContent =
        (territoryText ? territoryText + " — " : "") + brandText;

      if (!p.rows.length) {
        document.getElementById("portfolioEmptyState").classList.remove("hidden");
      } else {
        document.getElementById("portfolioTableBody").innerHTML = p.rows.map(portfolioRowHtml).join("");
      }
    } catch (err) {
      document.getElementById("portfolioDelegateName").textContent = "Could not load";
      if (window.MedvisitPro) MedvisitPro.showToast(err.message || "Could not load portfolio.", "error");
    }
  }

  // ---------- Assign Responsible Clients modal ----------
  // Territory first, by design: the manager can't see a client picker
  // at all until they've committed to one of this delegate's two
  // territories (Primary = Kigali City, Secondary = outside it) — see
  // list_clients_in_territory in api.py, which filters straight off
  // that choice.

  let assignResponsibleClientsTerritory = null;
  let assignResponsibleClientsCandidates = [];
  const selectedResponsibleClients = new Set();

  function closeAssignResponsibleClientsModal() {
    const modal = document.getElementById("assignResponsibleClientsModal");
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }

  function openAssignResponsibleClientsModal() {
    if (!currentPortfolioDelegate) return;
    const d = currentPortfolioDelegate;

    document.getElementById("assignResponsibleClientsDelegateName").textContent = d.full_name;
    document.getElementById("assignResponsibleClientsError").classList.add("hidden");
    document.getElementById("assignResponsibleClientsResult").classList.add("hidden");
    document.getElementById("assignResponsibleClientsResult").innerHTML = "";
    document.getElementById("assignResponsibleClientsSearch").value = "";
    document.getElementById("assignResponsibleClientsClientSection").classList.add("hidden");
    assignResponsibleClientsTerritory = null;
    assignResponsibleClientsCandidates = [];
    selectedResponsibleClients.clear();

    const territories = [
      d.primary_territory ? { label: `Primary — ${d.primary_territory}`, value: d.primary_territory } : null,
      d.secondary_territory ? { label: `Secondary — ${d.secondary_territory}`, value: d.secondary_territory } : null,
    ].filter(Boolean);

    const picker = document.getElementById("assignResponsibleClientsTerritoryPicker");
    const noTerritory = document.getElementById("assignResponsibleClientsNoTerritory");
    if (!territories.length) {
      picker.innerHTML = "";
      noTerritory.classList.remove("hidden");
    } else {
      noTerritory.classList.add("hidden");
      picker.innerHTML = territories
        .map((t) => `<button type="button" class="territory-pick-btn px-md py-sm border border-outline-variant rounded-btn font-label-md text-on-surface-variant" data-territory="${escapeHtml(t.value)}">${escapeHtml(t.label)}</button>`)
        .join("");
      picker.querySelectorAll(".territory-pick-btn").forEach((btn) => {
        btn.addEventListener("click", () => selectAssignResponsibleClientsTerritory(btn.dataset.territory));
      });
    }

    const modal = document.getElementById("assignResponsibleClientsModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }

  async function selectAssignResponsibleClientsTerritory(territory) {
    assignResponsibleClientsTerritory = territory;
    selectedResponsibleClients.clear();
    document.querySelectorAll(".territory-pick-btn").forEach((btn) => {
      const active = btn.dataset.territory === territory;
      btn.classList.toggle("bg-primary", active);
      btn.classList.toggle("text-on-primary", active);
      btn.classList.toggle("text-on-surface-variant", !active);
    });
    document.getElementById("assignResponsibleClientsClientSection").classList.remove("hidden");
    await loadAssignResponsibleClientsCandidates();
  }

  async function loadAssignResponsibleClientsCandidates() {
    const listEl = document.getElementById("assignResponsibleClientsList");
    const emptyEl = document.getElementById("assignResponsibleClientsEmpty");
    listEl.innerHTML = '<p class="font-body-sm text-body-sm text-on-surface-variant p-sm">Loading…</p>';
    emptyEl.classList.add("hidden");

    const txt = document.getElementById("assignResponsibleClientsSearch").value.trim();
    try {
      assignResponsibleClientsCandidates = await callApi("list_clients_in_territory", {
        territory: assignResponsibleClientsTerritory, txt,
      });
      renderAssignResponsibleClientsList();
    } catch (err) {
      listEl.innerHTML = "";
      if (window.MedvisitPro) MedvisitPro.showToast(err.message || "Could not load clients.", "error");
    }
  }

  function renderAssignResponsibleClientsList() {
    const listEl = document.getElementById("assignResponsibleClientsList");
    const emptyEl = document.getElementById("assignResponsibleClientsEmpty");
    const rows = assignResponsibleClientsCandidates;

    if (!rows.length) {
      listEl.innerHTML = "";
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");

    listEl.innerHTML = rows.map((c) => {
      const already = c.assigned_delegate && c.assigned_delegate !== currentPortfolioDelegate.name;
      const note = c.assigned_delegate === currentPortfolioDelegate.name
        ? "Already this delegate's"
        : already
          ? `Currently: ${escapeHtml(c.assigned_delegate_name || c.assigned_delegate)}`
          : "Unassigned";
      return `<label class="flex items-center gap-sm p-sm cursor-pointer hover:bg-surface-container">
        <input type="checkbox" class="responsible-client-checkbox rounded border-outline-variant text-primary focus:ring-primary"
          value="${escapeHtml(c.name)}"${selectedResponsibleClients.has(c.name) ? " checked" : ""}>
        <span class="flex-grow">
          <span class="block font-body-sm text-body-sm text-on-surface">${escapeHtml(c.customer_name)}</span>
          <span class="block font-body-sm text-body-sm text-on-surface-variant">${escapeHtml(c.district || "—")} · ${escapeHtml(c.customer_class || "Unclassed")} · ${note}</span>
        </span>
      </label>`;
    }).join("");

    listEl.querySelectorAll(".responsible-client-checkbox").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) selectedResponsibleClients.add(cb.value);
        else selectedResponsibleClients.delete(cb.value);
      });
    });
  }

  async function runAssignResponsibleClients() {
    const errEl = document.getElementById("assignResponsibleClientsError");
    errEl.classList.add("hidden");

    if (!selectedResponsibleClients.size) {
      errEl.textContent = "Choose at least one client.";
      errEl.classList.remove("hidden");
      return;
    }

    const btn = document.getElementById("runAssignResponsibleClientsBtn");
    btn.disabled = true;
    btn.textContent = "Assigning...";

    try {
      const result = await callApi("bulk_assign_clients", {
        delegate: currentPortfolioDelegate.name,
        customers: JSON.stringify(Array.from(selectedResponsibleClients)),
      });
      const resultEl = document.getElementById("assignResponsibleClientsResult");
      resultEl.classList.remove("hidden");
      resultEl.innerHTML =
        `<p class="font-body-md text-body-md"><span class="text-secondary">${result.counts.assigned} assigned</span>` +
        (result.counts.failed ? `, <span class="text-error">${result.counts.failed} failed</span>` : "") + `.</p>`;
      if (window.MedvisitPro) MedvisitPro.showToast(`${result.counts.assigned} client(s) assigned.`);

      selectedResponsibleClients.clear();
      await loadAssignResponsibleClientsCandidates();
      // The portfolio table sitting behind this modal is now stale.
      if (currentPortfolioDelegate) openDelegatePortfolio(currentPortfolioDelegate.name);
    } catch (err) {
      errEl.textContent = err.message || "Could not assign those clients.";
      errEl.classList.remove("hidden");
    } finally {
      btn.disabled = false;
      btn.textContent = "Assign Selected";
    }
  }

  async function confirmEditDelegate() {
    const errEl = document.getElementById("editDelegateError");
    errEl.classList.add("hidden");

    const full_name = document.getElementById("editDelegateName").value.trim();
    if (!full_name) {
      errEl.textContent = "Full name is required.";
      errEl.classList.remove("hidden");
      return;
    }

    const btn = document.getElementById("confirmEditDelegateBtn");
    btn.disabled = true;
    btn.textContent = "Saving...";

    try {
      const alsoManagerEl = document.getElementById("editDelegateAlsoManager");
      const alsoManager = alsoManagerEl ? alsoManagerEl.checked : editingDelegateIsManager;
      // Only send `brands` when the checklist was actually editable —
      // sending an empty list otherwise would read as "clear this
      // manager's brands" and trip the Regional-Manager-only gate on
      // a save that never touched brands at all. See update_delegate.
      // Territory is a Delegate-only concept — hidden on the form for a
      // manager, so don't submit whatever the (hidden) selects still
      // hold. update_delegate clears both server-side for a manager
      // regardless, but this keeps the request honest about what the
      // form actually asked for.
      const payload = {
        name: editingDelegate,
        full_name,
        mobile_no: document.getElementById("editDelegateMobile").value.trim() || null,
        also_manager: alsoManager,
        enabled: document.getElementById("editDelegateEnabled").checked ? 1 : 0,
        primary_territory: alsoManager ? null : (document.getElementById("editDelegatePrimaryTerritory").value || null),
        secondary_territory: alsoManager ? null : (document.getElementById("editDelegateSecondaryTerritory").value || null),
      };
      if (window.IS_REGIONAL_MANAGER && alsoManager) {
        const checkedBrands = [...document.querySelectorAll(".edit-delegate-brand:checked")].map((cb) => cb.value);
        payload.brands = JSON.stringify(checkedBrands);
      }
      const result = await callApi("update_delegate", payload);

      if (result && result.ok === false) {
        errEl.textContent = result.error || "Could not save changes.";
        errEl.classList.remove("hidden");
        if (window.MedvisitPro) MedvisitPro.showToast(errEl.textContent, "error");
        return;
      }

      // Reassignment is a separate, Regional-Manager-only action (its
      // own endpoint, its own brand re-inheritance), so it runs after
      // the core save and only when the picker actually changed. Skipped
      // for a manager — they report to no one, and the picker is hidden.
      const managerSel = document.getElementById("editDelegateManager");
      if (window.IS_REGIONAL_MANAGER && !alsoManager && managerSel) {
        const newManager = managerSel.value || null;
        if (newManager && newManager !== editingDelegateManager) {
          const reassigned = await callApi("reassign_delegate", {
            delegate: editingDelegate,
            new_manager: newManager,
          });
          if (reassigned && reassigned.ok === false) {
            errEl.textContent = reassigned.error || "Could not reassign this delegate.";
            errEl.classList.remove("hidden");
            if (window.MedvisitPro) MedvisitPro.showToast(errEl.textContent, "error");
            return;
          }
        }
      }

      closeEditDelegateModal();
      if (window.MedvisitPro) MedvisitPro.showToast(`"${full_name}" updated successfully.`, "success");
      delegateOptionsLoaded = false; // name may have changed — refresh the history filter dropdown
      if (currentTableView === "delegates") loadCurrentTableView();
    } catch (err) {
      errEl.textContent = err.message || "Could not save changes.";
      errEl.classList.remove("hidden");
      if (window.MedvisitPro) MedvisitPro.showToast(errEl.textContent, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Save Changes";
    }
  }

  // ============================================================
  // Bulk client import
  // ============================================================
  // The template download is a plain GET so the browser handles it as
  // a file save; the upload goes back base64-encoded through the same
  // JSON API as everything else on this page.

  // One sheet, one row per point of contact — creates or updates both
  // the Organization (Customer) and the specialist (Contact) together.
  // See import_roster/download_roster_template/list_roster_columns in
  // api.py — this used to be two separate imports (organizations, then
  // specialists); this modal only speaks the combined one now.

  // Delegate filter for the export — one delegate's own responsible-
  // client roster, not the whole company's. list_delegates() is already
  // brand-scoped (a manager only sees their own delegates), so the
  // option list can't leak a colleague's team.
  let delegateFilterCache = null;
  async function initExportDelegateFilter() {
    const select = document.getElementById("exportDelegateFilter");
    if (delegateFilterCache) {
      renderDelegateFilterOptions(select, delegateFilterCache);
      return;
    }
    try {
      delegateFilterCache = await callApi("list_delegates", {});
      renderDelegateFilterOptions(select, delegateFilterCache);
    } catch (err) {
      // The filter is a convenience — a failed fetch just leaves
      // "All delegates" as the only option, not a blocking error.
    }
  }

  function renderDelegateFilterOptions(select, delegates) {
    const current = select.value;
    select.innerHTML = '<option value="">All delegates</option>' +
      delegates.map((d) => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.full_name)}</option>`).join("");
    select.value = current;
  }

  function openImportModal() {
    document.getElementById("importFileInput").value = "";
    document.getElementById("importError").classList.add("hidden");
    document.getElementById("importResult").classList.add("hidden");
    document.getElementById("importResult").innerHTML = "";
    document.getElementById("exportColumnsError").classList.add("hidden");
    initExportDelegateFilter();
    exportColumnsCache = null;
    initExportColumns();
    refreshExportScopeLabel();
    const modal = document.getElementById("importClientsModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }

  function closeImportModal() {
    const modal = document.getElementById("importClientsModal");
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }

  // ---------- Export: column checklist + scope ----------
  //
  // The checklist is built from api.list_roster_columns() rather than
  // a hardcoded copy of the field list here — one source of truth for
  // "what a record has", the same reasoning that put the design tokens
  // in one shared tailwind.config.js instead of scattered copies.
  let exportColumnsCache = null;

  async function initExportColumns() {
    const container = document.getElementById("exportColumnList");
    if (exportColumnsCache) {
      renderExportColumnList(container, exportColumnsCache);
      return;
    }
    container.innerHTML = '<p class="font-body-sm text-body-sm text-on-surface-variant">Loading columns…</p>';
    try {
      exportColumnsCache = await callApi("list_roster_columns", {});
      renderExportColumnList(container, exportColumnsCache);
    } catch (err) {
      container.innerHTML = '<p class="font-body-sm text-body-sm text-error">Could not load columns.</p>';
    }
  }

  function renderExportColumnList(container, columns) {
    container.innerHTML = columns
      .map(
        (c) =>
          `<label class="flex items-center gap-xs cursor-pointer">` +
          `<input type="checkbox" class="export-column-checkbox rounded border-outline-variant text-primary focus:ring-primary" ` +
          `value="${escapeHtml(c.field)}" checked>` +
          `<span class="font-body-sm text-body-sm text-on-surface${c.recommended ? " font-semibold" : ""}">${escapeHtml(c.label)}</span>` +
          `</label>`
      )
      .join("");
  }

  function collectCheckedColumns() {
    return [...document.querySelectorAll(".export-column-checkbox:checked")].map((cb) => cb.value);
  }

  // "Exporting: N selected" beats a delegate filter when both are set —
  // checking rows on the Clients table is the more specific choice.
  // Kept live so the manager sees what they're about to download.
  function refreshExportScopeLabel() {
    const label = document.getElementById("exportScopeLabel");
    if (!label) return;
    const n = selectedClientIds.size;
    if (n) {
      label.textContent = `Exporting: ${n} selected point${n === 1 ? "" : "s"} of contact.`;
      return;
    }
    const select = document.getElementById("exportDelegateFilter");
    const chosen = select && select.options[select.selectedIndex];
    label.textContent = chosen && chosen.value
      ? `Exporting: the roster for ${chosen.textContent}.`
      : "Exporting: the full roster, every delegate. Check rows in the table, or pick a delegate, to narrow it.";
  }

  // mode "template" = blank sheet for adding — always the full column
  //                   set; picking columns only makes sense for data
  //                   that already exists.
  // mode "export"   = the current data, optionally scoped to a row
  //                   selection or a delegate, and a chosen column
  //                   subset.
  function downloadTemplate(fmt, mode, contactIds, columns, delegate) {
    let url = "/api/method/medvisitpro.api.download_roster_template?fmt=" + encodeURIComponent(fmt) +
      "&mode=" + encodeURIComponent(mode || "template");
    if (contactIds && contactIds.length) {
      url += "&contacts=" + encodeURIComponent(contactIds.join(","));
    }
    if (columns && columns.length) {
      url += "&columns=" + encodeURIComponent(columns.join(","));
    }
    if (delegate) {
      url += "&delegate=" + encodeURIComponent(delegate);
    }
    window.location.href = url;
  }

  function runExport(fmt) {
    const columns = collectCheckedColumns();
    const errEl = document.getElementById("exportColumnsError");
    if (!columns.length) {
      errEl.classList.remove("hidden");
      return;
    }
    errEl.classList.add("hidden");
    // A row selection on the Clients table takes precedence over the
    // delegate filter — picking specific rows is the more deliberate
    // choice of the two.
    const scope = Array.from(selectedClientIds);
    const delegate = scope.length ? null : document.getElementById("exportDelegateFilter").value;
    downloadTemplate(fmt, "export", scope, columns, delegate);
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      // result is a data: URL — strip the "data:...;base64," prefix.
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("Could not read that file."));
      reader.readAsDataURL(file);
    });
  }

  async function runImport() {
    const errEl = document.getElementById("importError");
    errEl.classList.add("hidden");

    const file = document.getElementById("importFileInput").files[0];
    if (!file) {
      errEl.textContent = "Choose a file first.";
      errEl.classList.remove("hidden");
      return;
    }

    const btn = document.getElementById("runImportBtn");
    btn.disabled = true;
    btn.textContent = "Uploading...";

    try {
      const content = await readFileAsBase64(file);
      const method = "import_roster";
      const result = await callApi(method, { filename: file.name, content });
      renderImportResult(result);
      if (result.counts.created || result.counts.updated) {
        if (window.MedvisitPro) {
          const parts = [];
          if (result.counts.created) parts.push(result.counts.created + " created");
          if (result.counts.updated) parts.push(result.counts.updated + " updated");
          MedvisitPro.showToast(parts.join(", ") + ".");
        }
        // The Clients table is almost certainly behind this modal.
        if (currentTableView === "clients") loadCurrentTableView();
      }
    } catch (err) {
      errEl.textContent = err.message || "Could not import that file.";
      errEl.classList.remove("hidden");
    } finally {
      btn.disabled = false;
      btn.textContent = "Upload";
    }
  }

  // Failures and skips are rendered as a table rather than prose: the
  // point is to find the offending row in the spreadsheet fast, so
  // the row number and the exact offending value lead.
  function importRowTable(title, rows, tone) {
    if (!rows.length) return "";

    const body = rows
      .map(
        (r) =>
          "<tr>" +
          '<td class="py-1 pr-md font-label-md text-label-md whitespace-nowrap">' + r.row + "</td>" +
          '<td class="py-1 pr-md text-body-sm">' + escapeHtml(r.name || "—") + "</td>" +
          '<td class="py-1 pr-md text-body-sm">' + escapeHtml(r.column || "—") + "</td>" +
          '<td class="py-1 pr-md text-body-sm font-mono">' + escapeHtml(r.value || "—") + "</td>" +
          '<td class="py-1 text-body-sm ' + tone + '">' + escapeHtml(r.reason || "") + "</td>" +
          "</tr>"
      )
      .join("");

    return (
      '<p class="font-label-md text-label-md mt-md mb-xs">' + title + " (" + rows.length + ")</p>" +
      '<div class="overflow-x-auto">' +
        '<table class="w-full text-left border-collapse">' +
          '<thead><tr class="border-b border-outline-variant text-on-surface-variant">' +
            '<th class="py-1 pr-md font-label-sm text-label-sm">Row</th>' +
            '<th class="py-1 pr-md font-label-sm text-label-sm">Client</th>' +
            '<th class="py-1 pr-md font-label-sm text-label-sm">Column</th>' +
            '<th class="py-1 pr-md font-label-sm text-label-sm">Value</th>' +
            '<th class="py-1 font-label-sm text-label-sm">Problem</th>' +
          "</tr></thead>" +
          "<tbody>" + body + "</tbody>" +
        "</table>" +
      "</div>"
    );
  }

  function renderImportResult(result) {
    const c = result.counts;
    const box = document.getElementById("importResult");

    box.innerHTML =
      '<h3 class="font-label-md text-label-md text-primary mb-sm">RESULT</h3>' +
      '<div class="flex gap-md flex-wrap font-body-md text-body-md">' +
        '<span class="text-secondary">' + c.created + " created</span>" +
        '<span class="text-primary">' + (c.updated || 0) + " updated</span>" +
        '<span class="text-on-surface-variant">' + c.skipped + " skipped</span>" +
        '<span class="' + (c.failed ? "text-error" : "text-on-surface-variant") + '">' +
          c.failed + " failed</span>" +
        '<span class="text-on-surface-variant">of ' + c.total + " row(s)</span>" +
      "</div>" +
      ((c.created || c.updated) && !c.skipped && !c.failed
        ? '<p class="font-body-sm text-body-sm text-secondary mt-sm">Every row imported cleanly.</p>'
        : "") +
      importRowTable("Failed — not imported", result.failed, "text-error") +
      importRowTable("Updated", (result.updated || []).map((u) => ({
        row: u.row,
        name: u.name,
        // Spell out what moved, so an unexpected edit is visible rather
        // than hidden behind a bare "updated" count.
        reason: u.changed && u.changed.length
          ? "Changed: " + u.changed.join(", ")
          : u.reason || "No change.",
      })), "text-primary") +
      importRowTable("Skipped — already on file", result.skipped, "text-on-surface-variant") +
      (c.failed || c.skipped
        ? '<p class="font-body-sm text-body-sm text-on-surface-variant mt-sm">' +
          "Row numbers match the spreadsheet, counting the header as row 1. " +
          "Fix those rows and upload the file again — the clients already created will be skipped." +
          "</p>"
        : "") +
      (c.failed
        ? '<button type="button" id="reuploadAfterFailureBtn" class="mt-sm px-md py-sm border border-primary text-primary rounded-btn font-label-md">' +
          "Choose a corrected file" +
          "</button>"
        : "");

    box.classList.remove("hidden");

    // Jumps straight to the OS file picker — the "Upload" button
    // itself is in the modal's fixed footer, already visible without
    // scrolling, so picking a file here is the only step that's
    // otherwise buried above a long failed-rows table.
    const reuploadBtn = document.getElementById("reuploadAfterFailureBtn");
    if (reuploadBtn) {
      reuploadBtn.addEventListener("click", () => document.getElementById("importFileInput").click());
    }
  }

  // ============================================================
  // Plan approvals
  // ============================================================
  // Delegates propose their week here and raise ad-hoc requests
  // mid-week; nothing they proposed becomes a real Visit Assignment
  // until it's approved on this screen.

  let reviewingPlan = null;

  const PLAN_STATUS_STYLES = {
    "Draft": "bg-surface-container text-on-surface-variant",
    "Pending Approval": "bg-tertiary-container text-on-surface",
    "Approved": "bg-secondary text-on-primary",
    "Partially Approved": "bg-tertiary-container text-on-surface",
    "Rejected": "bg-error-container text-on-surface",
  };

  function showApprovalsView() {
    document.getElementById("dashboardView").classList.add("hidden");
    document.getElementById("tableView").classList.add("hidden");
    document.getElementById("approvalsView").classList.remove("hidden");
    document.getElementById("dashboardOnlySidebar").classList.add("hidden");
    document.getElementById("dashboardOnlyStatusFilter").classList.add("hidden");
    setActiveNav("approvals");
    currentTableView = null;
    loadApprovals();
  }

  async function loadApprovals() {
    const container = document.getElementById("approvalsList");
    container.innerHTML =
      '<p class="font-body-sm text-body-sm text-on-surface-variant">Loading...</p>';

    const status = document.getElementById("approvalsStatusFilter").value;
    try {
      const data = await callApi("list_plan_approvals", { status });
      MedvisitPro.renderApprovalsBadge(data.pending_count);
      renderApprovalsList(data.plans);
    } catch (err) {
      container.innerHTML = "";
      if (window.MedvisitPro) MedvisitPro.showToast(err.message || "Could not load approvals.", "error");
    }
  }


  function renderApprovalsList(plans) {
    const container = document.getElementById("approvalsList");
    container.innerHTML = "";

    if (!plans.length) {
      container.innerHTML =
        '<p class="font-body-sm text-body-sm text-on-surface-variant">Nothing here right now.</p>';
      return;
    }

    // Ad-hoc requests first: a delegate is standing in front of a
    // client waiting on those, where a next-week plan can sit a while.
    plans.sort((a, b) => (b.pending_adhoc > 0) - (a.pending_adhoc > 0));

    plans.forEach((p) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className =
        "w-full text-left bg-surface-container-lowest p-md rounded-xl border border-outline-variant " +
        "ambient-shadow hover:border-primary transition-all flex items-center justify-between gap-md";
      card.innerHTML =
        '<div class="min-w-0">' +
          '<p class="font-label-lg text-label-lg truncate">' + escapeHtml(p.delegate_name) + "</p>" +
          '<p class="font-body-sm text-body-sm text-on-surface-variant">Week of ' +
            escapeHtml(p.week_start_date) + " · " + p.total_visits + " visit" +
            (p.total_visits === 1 ? "" : "s") +
            (p.pending_visits ? " · " + p.pending_visits + " awaiting you" : "") +
          "</p>" +
        "</div>" +
        '<div class="flex items-center gap-sm flex-shrink-0">' +
          (p.pending_adhoc
            ? '<span class="px-sm py-1 rounded-full font-label-sm text-label-sm bg-error text-on-primary">' +
              p.pending_adhoc + " ad-hoc</span>"
            : "") +
          '<span class="px-sm py-1 rounded-full font-label-sm text-label-sm ' +
            (PLAN_STATUS_STYLES[p.status] || "bg-surface-container text-on-surface-variant") + '">' +
            escapeHtml(p.status) + "</span>" +
        "</div>";
      card.addEventListener("click", () => openPlanReview(p.name));
      container.appendChild(card);
    });
  }

  async function openPlanReview(planName) {
    const modal = document.getElementById("planReviewModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    document.getElementById("reviewError").classList.add("hidden");
    document.getElementById("reviewLines").innerHTML =
      '<p class="font-body-sm text-body-sm text-on-surface-variant">Loading...</p>';

    try {
      reviewingPlan = await callApi("get_plan_details", { plan: planName });
      renderPlanReview();
    } catch (err) {
      document.getElementById("reviewLines").innerHTML = "";
      showReviewError(err.message || "Could not load this plan.");
    }
  }

  function closePlanReviewModal() {
    const modal = document.getElementById("planReviewModal");
    modal.classList.add("hidden");
    modal.classList.remove("flex");
    reviewingPlan = null;
  }

  function showReviewError(msg) {
    const el = document.getElementById("reviewError");
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  // Who (Point of Contact — Speciality) and what they're worth
  // covering (Org-Type · expected visits/month) — so a manager
  // reviewing a line sees the same context the delegate planned it
  // with, not just a client name and a date.
  function planLineMeta(l) {
    const parts = [];
    if (l.contact_person_name) {
      parts.push(
        "Contact: " + (l.contact_speciality
          ? escapeHtml(l.contact_person_name) + " — " + escapeHtml(l.contact_speciality)
          : escapeHtml(l.contact_person_name))
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

  function renderPlanReview() {
    const p = reviewingPlan;
    document.getElementById("reviewDelegateName").textContent = p.delegate_name;
    document.getElementById("reviewWeekLabel").textContent =
      "Week of " + p.week_start_date + " · " + p.status;

    const container = document.getElementById("reviewLines");
    container.innerHTML = "";

    p.lines.forEach((l) => {
      const decided = l.approval_status !== "Pending";
      const row = document.createElement("div");
      row.className = "p-md rounded-lg border border-outline-variant";
      row.innerHTML =
        '<div class="flex items-start justify-between gap-md">' +
          '<div class="min-w-0">' +
            '<p class="font-label-md text-label-md truncate">' + escapeHtml(l.customer_name) + "</p>" +
            '<p class="font-body-sm text-body-sm text-on-surface-variant">' +
              escapeHtml(l.scheduled_date || "") +
              (l.scheduled_time ? " · " + escapeHtml(l.scheduled_time) : "") +
            "</p>" +
            planLineMeta(l) +
            (l.visit_type === "Ad-hoc"
              ? '<p class="font-body-sm text-body-sm text-on-surface mt-1"><span class="font-label-sm text-label-sm">Reason: </span>' +
                escapeHtml(l.reason || "") + "</p>"
              : "") +
            (l.manager_comment
              ? '<p class="font-body-sm text-body-sm text-error mt-1">' + escapeHtml(l.manager_comment) + "</p>"
              : "") +
          "</div>" +
          '<div class="flex items-center gap-sm flex-shrink-0">' +
            (l.visit_type === "Ad-hoc"
              ? '<span class="px-sm py-1 rounded-full font-label-sm text-label-sm bg-surface-container text-on-surface-variant">Ad-hoc</span>'
              : "") +
            '<span class="px-sm py-1 rounded-full font-label-sm text-label-sm ' +
              (PLAN_STATUS_STYLES[l.approval_status] || "bg-tertiary-container text-on-surface") + '">' +
              escapeHtml(l.approval_status) + "</span>" +
          "</div>" +
        "</div>" +
        (decided
          ? ""
          : '<div class="flex gap-sm mt-sm">' +
              '<button type="button" data-approve class="px-md py-1.5 rounded-lg bg-primary text-on-primary font-label-md">Approve</button>' +
              '<button type="button" data-reject class="px-md py-1.5 rounded-lg border border-error text-error font-label-md">Reject</button>' +
            "</div>");

      if (!decided) {
        row.querySelector("[data-approve]").addEventListener(
          "click", () => decideLine(l.row, "Approved", null)
        );
        row.querySelector("[data-reject]").addEventListener("click", () => {
          const comment = prompt("Why are you sending this visit back?");
          if (comment === null) return;
          if (!comment.trim()) {
            showReviewError("A rejection needs a reason.");
            return;
          }
          decideLine(l.row, "Rejected", comment);
        });
      }

      container.appendChild(row);
    });

    // Bulk actions only make sense while something is still pending.
    const hasPending = p.counts.pending > 0;
    document.getElementById("approvePlanBtn").classList.toggle("hidden", !hasPending);
    document.getElementById("rejectPlanBtn").classList.toggle("hidden", !hasPending);
  }

  async function decideLine(row, decision, comment) {
    document.getElementById("reviewError").classList.add("hidden");
    try {
      const result = await callApi("decide_plan_visit", {
        plan: reviewingPlan.name,
        row: row,
        decision: decision,
        comment: comment,
      });
      reviewingPlan = result.plan;
      renderPlanReview();
      loadApprovals();
      if (window.MedvisitPro) {
        MedvisitPro.showToast(
          decision === "Approved" ? "Visit approved." : "Visit sent back."
        );
      }
    } catch (err) {
      showReviewError(err.message || "Could not save that decision.");
    }
  }

  async function approveWholePlan() {
    const btn = document.getElementById("approvePlanBtn");
    btn.disabled = true;
    document.getElementById("reviewError").classList.add("hidden");
    try {
      const result = await callApi("approve_plan", { plan: reviewingPlan.name });
      reviewingPlan = result.plan;
      renderPlanReview();
      loadApprovals();
      if (window.MedvisitPro) MedvisitPro.showToast("Plan approved.");
    } catch (err) {
      showReviewError(err.message || "Could not approve this plan.");
    } finally {
      btn.disabled = false;
    }
  }

  async function rejectWholePlan() {
    const comment = prompt("Why are you sending this plan back?");
    if (comment === null) return;
    if (!comment.trim()) {
      showReviewError("A rejection needs a reason.");
      return;
    }

    const btn = document.getElementById("rejectPlanBtn");
    btn.disabled = true;
    document.getElementById("reviewError").classList.add("hidden");
    try {
      const result = await callApi("reject_plan", { plan: reviewingPlan.name, comment });
      reviewingPlan = result.plan;
      renderPlanReview();
      loadApprovals();
      if (window.MedvisitPro) MedvisitPro.showToast("Plan sent back to the delegate.");
    } catch (err) {
      showReviewError(err.message || "Could not reject this plan.");
    } finally {
      btn.disabled = false;
    }
  }

  async function refreshApprovalsBadge() {
    try {
      const data = await callApi("list_plan_approvals", { status: "Pending Approval" });
      MedvisitPro.renderApprovalsBadge(data.pending_count);
    } catch (e) {
      // A badge is not worth surfacing an error over.
    }
  }

  // Detail/edit modal wiring: close buttons, click-outside, and Escape.
  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("confirmActionCancelBtn").addEventListener("click", closeConfirmModal);
    document.getElementById("confirmActionModal").addEventListener("click", (e) => {
      if (e.target.id === "confirmActionModal") closeConfirmModal();
    });
    document.getElementById("confirmActionConfirmBtn").addEventListener("click", async () => {
      const handler = confirmActionHandler;
      const btn = document.getElementById("confirmActionConfirmBtn");
      btn.disabled = true;
      try {
        if (handler) await handler();
      } finally {
        btn.disabled = false;
        closeConfirmModal();
      }
    });

    // Column sort — delegated on the <thead> itself (not per-<th>,
    // which is rebuilt every render) so it keeps working across
    // searches, pagination, and view switches without rewiring.
    document.getElementById("tableHead").addEventListener("click", (e) => {
      const th = e.target.closest("[data-sort-col]");
      if (!th) return;
      const col = parseInt(th.dataset.sortCol, 10);
      tableSortDir = tableSortCol === col && tableSortDir === "asc" ? "desc" : "asc";
      tableSortCol = col;
      applyTableSort();
      tablePage = 1;
      renderTablePage();
    });

    // Gear icon opens a small menu (currently just one item) rather
    // than the Import/Export modal directly.
    const tableSettingsBtn = document.getElementById("tableSettingsBtn");
    const tableSettingsMenu = document.getElementById("tableSettingsMenu");
    const setTableSettingsMenuOpen = (open) => {
      tableSettingsMenu.classList.toggle("hidden", !open);
      tableSettingsBtn.setAttribute("aria-expanded", open ? "true" : "false");
    };
    tableSettingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeColumnsPanel();
      updateTableSettingsDeleteState();
      setTableSettingsMenuOpen(tableSettingsMenu.classList.contains("hidden"));
    });
    document.getElementById("tableSettingsImportExportBtn").addEventListener("click", () => {
      setTableSettingsMenuOpen(false);
      openImportModal();
    });
    // Bulk-deletes whichever rows are checked — the same selection
    // Export uses. Replaces the old per-row Delete button on the
    // Clients table (see bulk_delete_client_contacts in api.py).
    document.getElementById("tableSettingsDeleteBtn").addEventListener("click", () => {
      if (!selectedClientIds.size) return; // disabled state should prevent this, but don't act on empty anyway
      setTableSettingsMenuOpen(false);
      const n = selectedClientIds.size;
      openConfirmModal({
        title: `Delete ${n} selected point${n === 1 ? "" : "s"} of contact?`,
        message: "This can't be undone.",
        confirmLabel: "Delete",
        onConfirm: async () => {
          try {
            const result = await callApi("bulk_delete_client_contacts", {
              contacts: JSON.stringify(Array.from(selectedClientIds)),
            });
            selectedClientIds.clear();
            if (window.MedvisitPro) MedvisitPro.showToast(`${result.deleted} deleted.`);
            if (currentTableView === "clients") loadCurrentTableView();
          } catch (err) {
            if (window.MedvisitPro) MedvisitPro.showToast(err.message || "Could not delete the selected points of contact.", "error");
          }
        },
      });
    });
    document.addEventListener("click", (e) => {
      if (!tableSettingsMenu.classList.contains("hidden") && !tableSettingsMenu.contains(e.target) && e.target !== tableSettingsBtn) {
        setTableSettingsMenuOpen(false);
      }
    });
    document.getElementById("tableSettingsColumnsBtn").addEventListener("click", () => {
      setTableSettingsMenuOpen(false);
      openColumnsPanel();
    });
    document.addEventListener("click", (e) => {
      const panel = document.getElementById("tableColumnsPanel");
      if (!panel.classList.contains("hidden") && !panel.contains(e.target) && e.target !== tableSettingsBtn) {
        closeColumnsPanel();
      }
    });
    document.getElementById("closeImportBtn").addEventListener("click", closeImportModal);
    document.getElementById("cancelImportBtn").addEventListener("click", closeImportModal);
    document.getElementById("runImportBtn").addEventListener("click", runImport);
    document.getElementById("downloadXlsxBtn").addEventListener("click", () => downloadTemplate("xlsx"));
    document.getElementById("downloadCsvBtn").addEventListener("click", () => downloadTemplate("csv"));
    document.getElementById("exportXlsxBtn").addEventListener("click", () => runExport("xlsx"));
    document.getElementById("exportCsvBtn").addEventListener("click", () => runExport("csv"));
    document.getElementById("exportDelegateFilter").addEventListener("change", refreshExportScopeLabel);
    document.getElementById("importClientsModal").addEventListener("click", (e) => {
      if (e.target.id === "importClientsModal") closeImportModal();
    });

    document.getElementById("approvalsBackBtn").addEventListener("click", () => handleNav("dashboard"));
    document.getElementById("approvalsStatusFilter").addEventListener("change", loadApprovals);
    document.getElementById("closePlanReviewBtn").addEventListener("click", closePlanReviewModal);
    document.getElementById("approvePlanBtn").addEventListener("click", approveWholePlan);
    document.getElementById("rejectPlanBtn").addEventListener("click", rejectWholePlan);
    document.getElementById("planReviewModal").addEventListener("click", (e) => {
      if (e.target.id === "planReviewModal") closePlanReviewModal();
    });
    refreshApprovalsBadge();

    document.getElementById("closeVisitDetailBtn").addEventListener("click", closeVisitDetailModal);
    document.getElementById("visitDetailModal").addEventListener("click", (e) => {
      if (e.target.id === "visitDetailModal") closeVisitDetailModal();
    });

    document.getElementById("closeClientDetailBtn").addEventListener("click", closeClientDetailModal);
    document.getElementById("clientDetailModal").addEventListener("click", (e) => {
      if (e.target.id === "clientDetailModal") closeClientDetailModal();
    });

    document.getElementById("confirmEditDelegateBtn").addEventListener("click", confirmEditDelegate);
    document.getElementById("cancelEditDelegateBtn").addEventListener("click", closeEditDelegateModal);

    // Reassign modal buttons only exist for a Regional Manager (guarded
    // in the template), so null-check before wiring.
    const confirmReassignBtn = document.getElementById("confirmReassignDelegateBtn");
    if (confirmReassignBtn) {
      confirmReassignBtn.addEventListener("click", confirmReassignDelegate);
      document.getElementById("cancelReassignDelegateBtn").addEventListener("click", closeReassignDelegateModal);
      document.getElementById("reassignDelegateModal").addEventListener("click", (e) => {
        if (e.target.id === "reassignDelegateModal") closeReassignDelegateModal();
      });
    }
    document.getElementById("editDelegateModal").addEventListener("click", (e) => {
      if (e.target.id === "editDelegateModal") closeEditDelegateModal();
    });

    document.getElementById("viewDelegatePortfolioBtn").addEventListener("click", () => {
      if (editingDelegate) openDelegatePortfolio(editingDelegate);
    });
    document.getElementById("closePortfolioBtn").addEventListener("click", closeDelegatePortfolioModal);
    document.getElementById("delegatePortfolioModal").addEventListener("click", (e) => {
      if (e.target.id === "delegatePortfolioModal") closeDelegatePortfolioModal();
    });

    document.getElementById("openAssignResponsibleClientsBtn").addEventListener("click", openAssignResponsibleClientsModal);
    document.getElementById("closeAssignResponsibleClientsBtn").addEventListener("click", closeAssignResponsibleClientsModal);
    document.getElementById("cancelAssignResponsibleClientsBtn").addEventListener("click", closeAssignResponsibleClientsModal);
    document.getElementById("runAssignResponsibleClientsBtn").addEventListener("click", runAssignResponsibleClients);
    document.getElementById("assignResponsibleClientsModal").addEventListener("click", (e) => {
      if (e.target.id === "assignResponsibleClientsModal") closeAssignResponsibleClientsModal();
    });
    let responsibleClientsSearchTimer = null;
    document.getElementById("assignResponsibleClientsSearch").addEventListener("input", () => {
      clearTimeout(responsibleClientsSearchTimer);
      responsibleClientsSearchTimer = setTimeout(loadAssignResponsibleClientsCandidates, 300);
    });
    // Delete, on the Delegates table — delete_delegate (api.py)
    // refuses when there's real history on file (visits, assignments,
    // orders, a team still reporting to a manager); disabling is the
    // tool for anyone with a real track record, this is only for a
    // record that was never actually used. Also handles Delete on the
    // Clients table (now a Points-of-Contact list — see below) and
    // Archive/Restore on Visit History — async because Restore (unlike the
    // others) calls the API directly rather than through
    // openConfirmModal's own await.
    document.addEventListener("click", async (e) => {
      const reassignBtn = e.target.closest(".reassign-delegate-btn");
      if (reassignBtn) {
        openReassignDelegateModal(
          reassignBtn.dataset.delegate,
          reassignBtn.dataset.name || reassignBtn.dataset.delegate,
          reassignBtn.dataset.manager || null,
        );
        return;
      }

      const delBtn = e.target.closest(".delete-delegate-btn");
      if (delBtn) {
        const label = delBtn.dataset.name || delBtn.dataset.delegate;
        openConfirmModal({
          title: `Delete ${label}?`,
          message: "This only works if they have no visit history, assignments, or assigned clients on file — disable the account instead if they do. This can't be undone.",
          confirmLabel: "Delete",
          onConfirm: async () => {
            try {
              const result = await callApi("delete_delegate", { name: delBtn.dataset.delegate });
              if (result && result.ok === false) {
                if (window.MedvisitPro) MedvisitPro.showToast(result.error || "Could not delete this delegate.", "error");
                return;
              }
              if (window.MedvisitPro) MedvisitPro.showToast(`${label} deleted.`);
              delegateOptionsLoaded = false;
              if (currentTableView === "delegates") loadCurrentTableView();
            } catch (err) {
              if (window.MedvisitPro) MedvisitPro.showToast(err.message || "Could not delete this delegate.", "error");
            }
          },
        });
        return;
      }

      // Visit History: Archive soft-deletes a row (real history stays
      // on file, just hidden from the default view — see
      // archive_visit_assignment). Restore undoes it; only rendered
      // for a Regional Manager in the first place, but the server is
      // the actual gate (_require_admin_or_regional_manager).
      const archiveBtn = e.target.closest(".archive-visit-btn");
      if (archiveBtn) {
        openConfirmModal({
          title: "Archive this visit?",
          message: "It's removed from Visit History by default, but nothing is deleted — a Regional Manager can restore it with \"Show Archived\" turned on.",
          confirmLabel: "Archive",
          onConfirm: async () => {
            try {
              const result = await callApi("archive_visit_assignment", { assignment: archiveBtn.dataset.visit });
              if (result && result.ok === false) {
                if (window.MedvisitPro) MedvisitPro.showToast(result.error || "Could not archive this visit.", "error");
                return;
              }
              if (window.MedvisitPro) MedvisitPro.showToast("Visit archived.");
              if (currentTableView === "history") loadCurrentTableView();
            } catch (err) {
              if (window.MedvisitPro) MedvisitPro.showToast(err.message || "Could not archive this visit.", "error");
            }
          },
        });
        return;
      }

      const restoreBtn = e.target.closest(".restore-visit-btn");
      if (restoreBtn) {
        try {
          restoreBtn.disabled = true;
          const result = await callApi("restore_visit_assignment", { assignment: restoreBtn.dataset.visit });
          if (result && result.ok === false) {
            if (window.MedvisitPro) MedvisitPro.showToast(result.error || "Could not restore this visit.", "error");
            return;
          }
          if (window.MedvisitPro) MedvisitPro.showToast("Visit restored.");
          if (currentTableView === "history") loadCurrentTableView();
        } catch (err) {
          if (window.MedvisitPro) MedvisitPro.showToast(err.message || "Could not restore this visit.", "error");
        }
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeVisitDetailModal();
        closeClientDetailModal();
        closeEditDelegateModal();
        closeDelegatePortfolioModal();
        closePlanReviewModal();
        closeImportModal();
      }
    });
  });
})();
