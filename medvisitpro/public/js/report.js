/**
 * /report — the manager's analytics page.
 *
 * This code used to live in managers.js and render inside an "Analytics"
 * section on the dashboard. The dashboard is now purely operational
 * (this week's headline numbers, who is behind, the visit list), and
 * everything period-scoped moved here.
 *
 * callApi / escapeHtml / the profile menu / the approvals badge are
 * shared with managers.js from common.js.
 */
(function () {
  "use strict";

  const callApi = MedvisitPro.callApi;
  const escapeHtml = MedvisitPro.escapeHtml;

  let analyticsData = JSON.parse(document.getElementById("analytics-data").textContent);
  // Six-month trend. Server-rendered rather than fetched: it is a
  // fixed window that the period selectors do not scope, so there is
  // nothing to re-request when they change.
  const trendData = JSON.parse(document.getElementById("trend-data").textContent);

  function initAnalytics() {
    document.getElementById("metricTotalVisits").textContent = analyticsData.total_visits;
    document.getElementById("metricOrderValue").textContent =
      analyticsData.total_order_value ? analyticsData.total_order_value.toLocaleString() : "0";
    document.getElementById("metricAdhoc").textContent =
      analyticsData.adhoc_count != null ? analyticsData.adhoc_count : 0;

    const avgs = analyticsData.category_averages || {};
    document.getElementById("metricAvgPharmacy").textContent = avgs["Pharmacy"] || 0;
    document.getElementById("metricAvgClinic").textContent = avgs["Clinic"] || 0;

    renderTopCustomers();
    renderCategoryReport();
  }

  function renderTopCustomers() {
    const list = document.getElementById("topCustomersList");
    list.innerHTML = "";
    if (!analyticsData.top_customers || analyticsData.top_customers.length === 0) {
      list.innerHTML = `<p class="text-body-sm text-on-surface-variant">No visits logged yet for the selected period.</p>`;
      return;
    }
    const maxVisits = analyticsData.top_customers[0].visits;
    analyticsData.top_customers.forEach((c) => {
      const row = document.createElement("div");
      row.className = "flex flex-col gap-1";
      row.innerHTML = `
        <div class="flex justify-between text-body-sm">
          <span class="text-on-surface font-medium">${escapeHtml(c.customer_name)}</span>
          <span class="text-on-surface-variant">${c.visits} visit${c.visits === 1 ? "" : "s"}</span>
        </div>
        <div class="w-full h-1.5 bg-surface-container rounded-full overflow-hidden">
          <div class="h-full bg-primary" style="width:${(c.visits / maxVisits) * 100}%"></div>
        </div>`;
      list.appendChild(row);
    });
  }

  // Colors cycle through these — matches the palette's primary/
  // secondary/tertiary-container/outline hex values directly, since
  // this Tailwind CDN setup doesn't expose them as CSS custom
  // properties for use in raw SVG attributes.
  const DONUT_COLORS = ["#00475e", "#24695f", "#4b596d", "#70787d"];
  const LEGEND_DOT_CLASSES = ["bg-primary", "bg-secondary", "bg-tertiary-container", "bg-outline"];

  function renderCategoryReport() {
    const breakdown = analyticsData.category_breakdown || [];
    const legend = document.getElementById("categoryLegend");
    const svg = document.getElementById("categoryDonut");
    const totalEl = document.getElementById("categoryDonutTotal");
    legend.innerHTML = "";
    svg.innerHTML = "";

    if (breakdown.length === 0) {
      legend.innerHTML = `<p class="text-body-sm text-on-surface-variant">No visits logged yet for the selected period.</p>`;
      totalEl.textContent = "0";
      return;
    }

    const total = breakdown.reduce((sum, b) => sum + b.visits, 0);
    totalEl.textContent = total;

    // Background track circle
    svg.innerHTML = `<circle class="text-surface-container" cx="18" cy="18" fill="transparent" r="15.915" stroke="currentColor" stroke-width="4"></circle>`;

    let cumulativeOffset = 0;
    breakdown.forEach((b, i) => {
      const color = DONUT_COLORS[i % DONUT_COLORS.length];
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", "18");
      circle.setAttribute("cy", "18");
      circle.setAttribute("fill", "transparent");
      circle.setAttribute("r", "15.915");
      circle.setAttribute("stroke", color);
      circle.setAttribute("stroke-width", "4");
      circle.setAttribute("stroke-dasharray", `${b.percent} ${100 - b.percent}`);
      circle.setAttribute("stroke-dashoffset", `${-cumulativeOffset}`);
      svg.appendChild(circle);
      cumulativeOffset += b.percent;

      const row = document.createElement("div");
      row.className = "flex items-center gap-md";
      row.innerHTML = `
        <div class="w-3 h-3 rounded-full ${LEGEND_DOT_CLASSES[i % LEGEND_DOT_CLASSES.length]}"></div>
        <div class="flex-grow">
          <p class="text-label-md text-on-surface">${escapeHtml(b.category)}</p>
          <p class="text-label-sm text-on-surface-variant">${b.visits} visit${b.visits === 1 ? "" : "s"} (${b.percent}%)</p>
        </div>`;
      legend.appendChild(row);
    });
  }

  // ---- Analytics period filter (Week N / Month / Year) ----

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function toISODate(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function mondayOf(date) {
    const d = new Date(date);
    const offset = (d.getDay() + 6) % 7; // Mon=0 .. Sun=6
    d.setDate(d.getDate() - offset);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function fmtShort(d) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  // The filter is two dependent dropdowns: pick a month (or the whole
  // year) first, then narrow to a Mon–Sat week within that month.
  const MONTH_YEAR_OPTS = { month: "short", year: "numeric" };

  function monthSelectEl() {
    return document.getElementById("analyticsMonth");
  }
  function weekSelectEl() {
    return document.getElementById("analyticsWeek");
  }

  // Month dropdown: "Entire Year", then each month of the current year.
  // Values: "year:<YYYY>" or "month:<YYYY-MM>".
  function buildMonthOptions() {
    const monthSel = monthSelectEl();
    const now = new Date();
    const year = now.getFullYear();
    monthSel.innerHTML = "";

    const yearOpt = document.createElement("option");
    yearOpt.value = `year:${year}`;
    yearOpt.textContent = `Entire Year (${year})`;
    monthSel.appendChild(yearOpt);

    for (let m = 0; m < 12; m++) {
      const opt = document.createElement("option");
      opt.value = `month:${year}-${pad2(m + 1)}`;
      opt.textContent = new Date(year, m, 1).toLocaleDateString(undefined, MONTH_YEAR_OPTS);
      if (m === now.getMonth()) opt.selected = true;
      monthSel.appendChild(opt);
    }
  }

  // Week dropdown for one month: "Entire Month", then each Mon–Sat week
  // overlapping it. Values: "month" or "week:<YYYY-MM-DD Monday>".
  // When selectCurrent is true, pre-selects the week containing today.
  function buildWeekOptions(year, month, selectCurrent) {
    const weekSel = weekSelectEl();
    weekSel.disabled = false;
    weekSel.innerHTML = "";

    const entireOpt = document.createElement("option");
    entireOpt.value = "month";
    entireOpt.textContent = "Entire Month";
    weekSel.appendChild(entireOpt);

    const lastOfMonth = new Date(year, month + 1, 0);
    const thisMonday = mondayOf(new Date()).getTime();
    let cursor = mondayOf(new Date(year, month, 1));
    let n = 1;
    while (cursor <= lastOfMonth) {
      const saturday = new Date(cursor);
      saturday.setDate(saturday.getDate() + 5);
      const opt = document.createElement("option");
      opt.value = `week:${toISODate(cursor)}`;
      opt.textContent = `Week ${n} (${fmtShort(cursor)} – ${fmtShort(saturday)})`;
      if (selectCurrent && cursor.getTime() === thisMonday) opt.selected = true;
      weekSel.appendChild(opt);
      cursor = new Date(cursor);
      cursor.setDate(cursor.getDate() + 7);
      n++;
    }
  }

  function periodPhrase() {
    const monthSel = monthSelectEl();
    const weekSel = weekSelectEl();
    const monthLabel = monthSel.options[monthSel.selectedIndex].textContent;
    if (monthSel.value.startsWith("year:")) return monthLabel; // e.g. "Entire Year (2026)"
    // Entire Month is option 0, so a selected week's index is its number.
    if (weekSel.value && weekSel.value.startsWith("week:")) {
      return `Week ${weekSel.selectedIndex} · ${monthLabel}`; // e.g. "Week 5 · July 2026"
    }
    return monthLabel; // e.g. "July 2026"
  }

  // There is no longer an "Analytics" section to head — its tiles and
  // charts sit with the rest of the summary at the top of the page, and
  // its period selectors sit in the header. The selected period is now
  // stated in the subtitle under the greeting, so it still reads as
  // scoping the figures rather than being an unlabelled control.
  function updateAnalyticsHeading() {
    const subtitle = document.getElementById("dashboardSubtitle");
    if (subtitle) {
      subtitle.textContent = `Team performance · ${periodPhrase()}`;
    }
    const tc = document.getElementById("topCustomersHeading");
    if (tc) {
      tc.innerHTML =
        `<span class="material-symbols-outlined text-[20px]">bar_chart</span> MOST VISITED CLIENTS`;
    }
  }

  async function fetchAnalytics(period, anchor) {
    const monthSel = monthSelectEl();
    const weekSel = weekSelectEl();
    monthSel.disabled = true;
    weekSel.disabled = true;
    try {
      analyticsData = await callApi("get_team_analytics", { period, anchor });
      initAnalytics();
      updateAnalyticsHeading();
    } catch (e) {
      alert("Couldn't load analytics: " + e.message);
    } finally {
      monthSel.disabled = false;
      weekSel.disabled = monthSel.value.startsWith("year:");
    }
  }

  // Month changed: for a year, drop the week picker and load the year;
  // for a month, rebuild the weeks and load the whole month to start.
  function onMonthChange() {
    const monthSel = monthSelectEl();
    const weekSel = weekSelectEl();
    const [kind, val] = monthSel.value.split(":");
    if (kind === "year") {
      weekSel.innerHTML = "";
      weekSel.disabled = true;
      fetchAnalytics("year", `${val}-01-01`);
      return;
    }
    const [y, m] = val.split("-").map(Number);
    buildWeekOptions(y, m - 1, false);
    fetchAnalytics("month", `${val}-01`);
  }

  function onWeekChange() {
    const monthVal = monthSelectEl().value.split(":")[1]; // YYYY-MM
    const weekVal = weekSelectEl().value;
    if (weekVal === "month") {
      fetchAnalytics("month", `${monthVal}-01`);
    } else {
      fetchAnalytics("week", weekVal.split(":")[1]); // Monday anchor
    }
  }

  function renderTrend(t) {
    const bars = document.getElementById("trendBars");
    const labels = document.getElementById("trendLabels");

    bars.innerHTML = t.months
      .map((m) => {
        // Floor the height so a month with visits is never invisible,
        // and keep zero flat so it stays distinguishable from one visit.
        const h = m.visits ? Math.max(m.height_percent, 6) : 0;
        return (
          '<div class="group relative flex-1 h-full flex items-end" title="' +
          `${escapeHtml(m.label)}: ${m.visits} visit${m.visits === 1 ? "" : "s"}">` +
          `<div class="w-full rounded-t bg-primary transition-all duration-700" style="height:${h}%"></div>` +
          '<span class="absolute -top-1 left-0 right-0 text-center font-label-sm text-label-sm text-on-surface ' +
          'opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">' +
          m.visits +
          "</span></div>"
        );
      })
      .join("");

    labels.innerHTML = t.months
      .map((m) => `<span class="flex-1 text-center">${escapeHtml(m.label)}</span>`)
      .join("");

    const target = document.getElementById("trendTarget");
    const progress = document.getElementById("trendProgress");

    if (!t.yearly_target) {
      // Derived from each enabled client's expected_visits_per_month,
      // which is driven by its class. No classed clients, no target.
      target.textContent = "Not set";
      target.className = "font-label-lg text-label-lg text-outline";
      progress.textContent = `${t.ytd_visits} logged`;
      progress.className = "font-label-lg text-label-lg text-on-surface";
      return;
    }
    target.textContent = `${t.yearly_target.toLocaleString()} visits`;
    target.className = "font-label-lg text-label-lg text-on-surface";
    progress.textContent = `${t.progress_percent}%`;
    progress.className = "font-label-lg text-label-lg text-secondary";
  }

  async function refreshApprovalsBadge() {
    try {
      const data = await callApi("list_plan_approvals", { status: "Pending Approval" });
      MedvisitPro.renderApprovalsBadge(data.pending_count);
    } catch (e) {
      // A badge is not worth surfacing an error over.
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    MedvisitPro.initProfileMenu();
    renderTrend(trendData);
    buildMonthOptions();
    buildWeekOptions(new Date().getFullYear(), new Date().getMonth(), true);
    initAnalytics();
    updateAnalyticsHeading();
    monthSelectEl().addEventListener("change", onMonthChange);
    weekSelectEl().addEventListener("change", onWeekChange);
    refreshApprovalsBadge();
  });
})();
