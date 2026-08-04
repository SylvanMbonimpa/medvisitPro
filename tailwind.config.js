                                                  /**
 * Single source of truth for the design tokens used by every MedvisitPro
 * page.
 *
 * These tokens previously lived in an inline `tailwind.config` <script>
 * duplicated across www/login.html, www/delegate.html and
 * www/managers.html, compiled in the browser by cdn.tailwindcss.com on
 * every page load. Three hand-maintained copies had already drifted
 * apart (login.html carried on-tertiary-fixed-variant #3a485b against
 * #3a484b in the other two, and a headline-lg-mobile token the others
 * lacked). One file removes that whole class of problem — and the CSS
 * is now built once at deploy time instead of on every visit.
 *
 * Rebuild after changing anything here, or after adding a class to a
 * template or a JS file:
 *     npm run build:css
 */
module.exports = {
  darkMode: "class",

  // Tailwind scans these for class names. The JS files matter as much as
  // the templates — most of the dashboard markup is rendered client-side
  // from template literals in public/js/.
  content: [
    "./medvisitpro/www/**/*.html",
    // The manager pages share their sidebar/top-bar/bottom-nav from
    // here. Miss this glob and every class in the shared chrome is
    // absent from the bundle — the page renders completely unstyled.
    "./medvisitpro/templates/**/*.html",
    "./medvisitpro/public/js/**/*.js",
  ],

  theme: {
    extend: {
      // Material 3 palette, updated to the manager-dashboard design.
      //
      // Two deliberate shifts: `primary` deepened to a near-navy with the
      // old primary demoted to `primary-container` (the two now read as
      // one family rather than two competing blues), and the tertiary
      // ramp moved from slate-blue to amber, giving charts and accents a
      // warm counterpoint to all the teal.
      //
      // Applied app-wide on purpose. A manager page on a different
      // primary to the login page its users just came through reads as
      // broken, and two palettes drift apart the moment anyone edits one.
      colors: {
        "background": "#f8f9fb",
        "error": "#ba1a1a",
        "error-container": "#ffdad6",
        "inverse-on-surface": "#f0f1f3",
        "inverse-primary": "#99cee9",
        "inverse-surface": "#2e3132",
        "on-background": "#191c1e",
        "on-error": "#ffffff",
        "on-error-container": "#93000a",
        "on-primary": "#ffffff",
        "on-primary-container": "#80b5cf",
        "on-primary-fixed": "#001f2b",
        "on-primary-fixed-variant": "#0b4d64",
        "on-secondary": "#ffffff",
        "on-secondary-container": "#296d63",
        "on-secondary-fixed": "#00201c",
        "on-secondary-fixed-variant": "#005047",
        "on-surface": "#191c1e",
        "on-surface-variant": "#40484c",
        "on-tertiary": "#ffffff",
        "on-tertiary-container": "#dca26c",
        "on-tertiary-fixed": "#2d1600",
        "on-tertiary-fixed-variant": "#663d0f",
        "outline": "#71787d",
        "outline-variant": "#c0c7cd",
        "primary": "#002f40",
        "primary-container": "#00475e",
        "primary-fixed": "#bfe8ff",
        "primary-fixed-dim": "#99cee9",
        "secondary": "#24695f",
        "secondary-container": "#a9ede0",
        "secondary-fixed": "#acefe2",
        "secondary-fixed-dim": "#91d3c7",
        "surface": "#f8f9fb",
        "surface-bright": "#f8f9fb",
        "surface-container": "#edeef0",
        "surface-container-high": "#e7e8ea",
        "surface-container-highest": "#e1e2e4",
        "surface-container-low": "#f3f3f6",
        "surface-container-lowest": "#ffffff",
        "surface-dim": "#d9dadc",
        "surface-tint": "#2d657d",
        "surface-variant": "#e1e2e4",
        "tertiary": "#432400",
        "tertiary-container": "#60380a",
        "tertiary-fixed": "#ffdcbf",
        "tertiary-fixed-dim": "#f7ba82",
      },

      // `btn` and `card` are new, from the design's 8px-control /
      // 12px-surface rule. `lg` and `xl` keep their old values on
      // purpose — they sit on hundreds of existing elements across all
      // three pages, and redefining them would silently reshape every
      // button and card in the app.
      borderRadius: {
        DEFAULT: "0.25rem",
        btn: "8px",
        card: "12px",
        lg: "0.5rem",
        xl: "0.75rem",
        full: "9999px",
      },

      spacing: {
        base: "4px",
        unit: "4px",
        xs: "8px",
        sm: "16px",
        gutter: "16px",
        "margin-mobile": "16px",
        md: "24px",
        "margin-desktop": "24px",
        lg: "40px",
        xl: "64px",
        "container-max": "1200px",
        // Outer bound for the centred manager shell (rail + content).
        // Wider than container-max because 256px of it is the sidebar,
        // leaving ~1184px of content — about the same reading width the
        // single-column pages get from container-max.
        "container-app": "1440px",
      },

      // Every type token resolves to the same stack. They stay separate
      // names because the markup pairs them (`font-body-md text-body-md`),
      // and so a future change can give one role its own family without
      // touching the rest.
      fontFamily: (() => {
        // Self-hosted; see the @font-face rules in styles/tailwind.css.
        // The rest of the stack only ever shows during the brief swap
        // window, or if the woff2 fails to load.
        const stack = [
          "IBM Plex Sans",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ];
        const roles = [
          "body-sm", "body-md", "body-lg",
          "label-sm", "label-md", "label-lg",
          "headline-sm", "headline-md", "headline-lg", "headline-lg-mobile",
          "display-lg",
        ];
        return Object.fromEntries([
          ["sans", stack],
          ...roles.map((r) => [r, stack]),
        ]);
      })(),

      fontSize: {
        "body-sm": ["14px", { lineHeight: "20px", fontWeight: "400" }],
        "body-md": ["16px", { lineHeight: "24px", fontWeight: "400" }],
        "body-lg": ["18px", { lineHeight: "28px", fontWeight: "400" }],
        "label-sm": ["12px", { lineHeight: "16px", fontWeight: "500" }],
        "label-md": ["14px", { lineHeight: "20px", letterSpacing: "0.05em", fontWeight: "600" }],
        // Two additions from the manager design. The rest of its scale is
        // deliberately NOT adopted: it redefines label-md 14px->12px and
        // body-md 16px->14px and drops body-sm entirely, and those three
        // are used ~200 times across all pages. Additive only.
        //
        // label-lg is row-level text in dense tables — label-md's size
        // without its wide tracking, which is unreadable in a table cell.
        // managers.js already used `text-label-lg` before it existed, so
        // that text has been rendering at the inherited body size.
        "label-lg": ["14px", { lineHeight: "20px", letterSpacing: "0.1px", fontWeight: "500" }],
        // Card section headers, between body text and headline-md.
        "headline-sm": ["20px", { lineHeight: "28px", fontWeight: "500" }],
        "headline-md": ["24px", { lineHeight: "32px", fontWeight: "600" }],
        "headline-lg": ["32px", { lineHeight: "40px", letterSpacing: "-0.01em", fontWeight: "600" }],
        // login.html only; same metrics as headline-md.
        "headline-lg-mobile": ["24px", { lineHeight: "32px", fontWeight: "600" }],
        "display-lg": ["48px", { lineHeight: "56px", letterSpacing: "-0.02em", fontWeight: "600" }],
      },
    },
  },

  // Matches the ?plugins=forms,container-queries the CDN was loaded with.
  plugins: [
    require("@tailwindcss/forms"),
    require("@tailwindcss/container-queries"),
  ],
};
