window.MedvisitPro = window.MedvisitPro || {};

MedvisitPro.logout = async function () {
  try {
    await fetch("/api/method/logout", {
      method: "POST",
      headers: { "X-Frappe-CSRF-Token": window.CSRF_TOKEN || "" },
      credentials: "same-origin",
    });
  } finally {
    window.location.href = "/login";
  }
};

MedvisitPro.showToast = function (message, type) {
  type = type || "success";

  let container = document.getElementById("mvp-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "mvp-toast-container";
    container.style.cssText =
      "position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px;";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.style.cssText =
    // font-family:inherit rather than a hardcoded family — the toast is
    // appended to <body>, so it picks up whatever stack the stylesheet
    // sets and can't be missed when that changes.
    "display:flex;align-items:flex-start;gap:8px;padding:12px 16px;border-radius:8px;color:#fff;" +
    "font-family:inherit;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.15);opacity:0;" +
    "transition:opacity 0.2s ease;max-width:320px;" +
    "background-color:" + (type === "error" ? "#ba1a1a" : "#00475e") + ";";

  const text = document.createElement("span");
  text.textContent = message;
  text.style.cssText = "flex-grow:1;";
  toast.appendChild(text);

  const dismiss = () => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 200);
  };

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.style.cssText =
    "flex-shrink:0;background:none;border:none;color:inherit;font-size:18px;line-height:1;" +
    "cursor:pointer;padding:0;opacity:0.8;";
  closeBtn.addEventListener("mouseenter", () => { closeBtn.style.opacity = "1"; });
  closeBtn.addEventListener("mouseleave", () => { closeBtn.style.opacity = "0.8"; });
  closeBtn.addEventListener("click", dismiss);
  toast.appendChild(closeBtn);

  container.appendChild(toast);

  requestAnimationFrame(() => { toast.style.opacity = "1"; });
  const autoDismiss = setTimeout(dismiss, 6000);
  closeBtn.addEventListener("click", () => clearTimeout(autoDismiss));
};

// ============================================================
// Shared helpers
// ============================================================
// Used by both managers.js and report.js. They live here rather than
// being copied into each page's script so there is exactly one
// implementation of the calling convention and the error unwrapping —
// the same reasoning that put the design tokens in one config.

MedvisitPro.escapeHtml = function (str) {
  return String(str === null || str === undefined ? "" : str).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
};

// Frappe wraps thrown messages in several shapes depending on whether
// the error came from frappe.throw, a validation hook, or an unhandled
// exception. Unwrap them to a single readable string.
MedvisitPro.extractFrappeError = function (data) {
  const candidates = [];
  if (data && data._server_messages) {
    try {
      JSON.parse(data._server_messages).forEach((raw) => {
        try {
          candidates.push(JSON.parse(raw).message);
        } catch (e) {
          candidates.push(raw);
        }
      });
    } catch (e) {
      /* not JSON — fall through to the other shapes */
    }
  }
  if (data && data.exception) candidates.push(String(data.exception).split(":").slice(1).join(":"));
  if (data && data.message) candidates.push(data.message);

  const message = candidates.find((c) => c && String(c).trim());
  return message
    ? String(message).replace(/<[^>]*>/g, "").trim()
    : "Something went wrong.";
};

MedvisitPro.callApi = async function (method, args) {
  const response = await fetch(`/api/method/medvisitpro.api.${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Frappe-CSRF-Token": window.CSRF_TOKEN || "",
    },
    credentials: "same-origin",
    body: JSON.stringify(args || {}),
  });

  let data = null;
  try {
    data = await response.json();
  } catch (e) {
    /* non-JSON body, handled below */
  }
  if (!response.ok) {
    throw new Error(MedvisitPro.extractFrappeError(data));
  }
  return data.message;
};

// Current date/time for the dashboard header, in the site's own
// operating timezone (Africa/Kigali) rather than whatever timezone the
// viewer's browser happens to be in — the team operates in one place,
// so "now" should read the same for everyone regardless of where a
// manager happens to be checking from. Ticks every 30s; a dashboard
// clock, not a stopwatch, so second-level precision isn't needed.
MedvisitPro.SITE_TIME_ZONE = "Africa/Kigali";

MedvisitPro.initLiveClock = function (elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const formatter = new Intl.DateTimeFormat("en-GB", {
    weekday: "long", day: "numeric", month: "long",
    hour: "2-digit", minute: "2-digit",
    timeZone: MedvisitPro.SITE_TIME_ZONE,
  });
  // The offset (e.g. "GMT+2") is pulled from a separate formatter
  // pass — Intl has no single-call way to get both the formatted
  // string and a bare "+2" offset — and shown alongside the IANA
  // name, so it reads as "Kigali time (GMT+2)" rather than either
  // half alone.
  const offsetFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: MedvisitPro.SITE_TIME_ZONE, timeZoneName: "shortOffset",
  });

  const render = () => {
    const now = new Date();
    const offsetPart = offsetFormatter.formatToParts(now).find((p) => p.type === "timeZoneName");
    const offset = offsetPart ? offsetPart.value : "";
    el.textContent = `${formatter.format(now)} · Kigali time${offset ? " (" + offset + ")" : ""}`;
  };

  render();
  setInterval(render, 30000);
};

// Name, avatar and dropdown in the top app bar. Identical on every
// manager page, so it is wired from here rather than per page.
MedvisitPro.initProfileMenu = function () {
  const name = window.MANAGER_NAME || "";
  const label = document.getElementById("managerNameLabel");
  if (label) label.textContent = name;

  const avatar = document.getElementById("managerAvatarContainer");
  if (avatar) {
    if (window.MANAGER_IMAGE) {
      const img = document.createElement("img");
      img.src = window.MANAGER_IMAGE;
      img.className = "w-full h-full object-cover";
      img.alt = name;
      avatar.appendChild(img);
    } else {
      avatar.textContent = name
        .split(" ")
        .map((w) => w[0])
        .slice(0, 2)
        .join("")
        .toUpperCase();
    }
  }

  const menuName = document.getElementById("profileMenuName");
  if (menuName) menuName.textContent = name;
  const menuEmail = document.getElementById("profileMenuEmail");
  if (menuEmail) menuEmail.textContent = window.MANAGER_EMAIL || "";

  const trigger = document.getElementById("profileTrigger");
  const menu = document.getElementById("profileMenu");
  if (!trigger || !menu) return;

  const setOpen = (open) => {
    menu.classList.toggle("hidden", !open);
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
  };
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(menu.classList.contains("hidden"));
  });
  // Close on outside click or Escape. Logout inside the menu is handled
  // by the delegated data-action="logout" listener below.
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("hidden") && !menu.contains(e.target) && !trigger.contains(e.target)) {
      setOpen(false);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });
};

// Collapses the manager sidebar (managers.html, report.html — the two
// pages that include manager_sidebar.html) to icons-only. Self-
// initializing on DOMContentLoaded rather than called from each page's
// own init function, since it's the same behaviour everywhere the
// sidebar appears and a page without one just no-ops. State persists
// across pages via localStorage — collapsing on the dashboard and then
// clicking through to Reports shouldn't expand it back.
const SIDEBAR_COLLAPSED_KEY = "mvp-sidebar-collapsed";

document.addEventListener("DOMContentLoaded", () => {
  const sidebar = document.getElementById("managerSidebar");
  const toggle = document.getElementById("sidebarToggleBtn");
  if (!sidebar || !toggle) return;

  const setCollapsed = (collapsed) => {
    sidebar.classList.toggle("sidebar-collapsed", collapsed);
    toggle.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    toggle.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  };

  setCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");

  toggle.addEventListener("click", () => {
    const collapsed = !sidebar.classList.contains("sidebar-collapsed");
    setCollapsed(collapsed);
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  });
});

// Pending-approval count. Appears in the sidebar, the top-bar bell and
// the mobile nav, so every .approvals-badge is updated together.
MedvisitPro.renderApprovalsBadge = function (count) {
  document.querySelectorAll(".approvals-badge").forEach((badge) => {
    badge.textContent = count;
    badge.classList.toggle("hidden", !count);
  });
};

// Event delegation on document body — this means ANY element with
// data-action="logout", on ANY page that loads this script, works
// automatically. No need to call addEventListener separately in
// each page's own JS file.
document.addEventListener("click", function (e) {
  const target = e.target.closest("[data-action='logout']");
  if (target) {
    e.preventDefault();
    MedvisitPro.logout();
  }
});
