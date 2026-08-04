import os

import frappe

# Static assets under public/ are served with a long Cache-Control, so a
# deploy that changes them would otherwise leave browsers running the old
# copy. Every page appends ?v=<token> to its asset URLs; the token is the
# newest mtime across everything bundled, so it changes exactly when
# something it covers does.
#
# This used to be a private _asset_version() copied into delegate.py and
# managers.py, each listing only its own two JS files — which meant a CSS
# change wouldn't have busted either page. One helper covering the whole
# public/ tree can't drift that way, and login.py (which had no
# versioning at all) now gets it for free.
#
# CAVEAT for fonts: the @font-face URLs live inside the built CSS and
# carry no ?v= of their own. Bumping this token refetches the CSS but not
# the woff2 files it points at. When you regenerate a font — adding an
# icon to the Material Symbols subset is the realistic case — give the
# file a new name and update styles/tailwind.css to match. See
# styles/README.md.
_VERSIONED_DIRS = ("css", "js", "fonts")


def asset_version():
    """Cache-busting token for this app's public assets."""
    public = frappe.get_app_path("medvisitpro", "public")

    latest = 0
    for subdir in _VERSIONED_DIRS:
        path = os.path.join(public, subdir)
        try:
            entries = os.scandir(path)
        except OSError:
            continue
        with entries:
            for entry in entries:
                if not entry.is_file():
                    continue
                try:
                    latest = max(latest, entry.stat().st_mtime)
                except OSError:
                    pass

    return str(int(latest))
