frappe.after_ajax(() => {
    function update_welcome_text() {
        const route = frappe.get_route();
        if (route[0] !== 'medvisitpro') return;

        // Find the header block containing "Welcome"
        const headers = document.querySelectorAll('.workspace-header, h1, h2, h3, [contenteditable]');
        headers.forEach(el => {
            if (el.textContent.trim().startsWith('Welcome')) {
                const fullname = frappe.session.user_fullname || frappe.session.user;
                el.textContent = `Welcome, ${fullname}`;
            }
        });
    }

    frappe.router.on('change', () => setTimeout(update_welcome_text, 400));
    setTimeout(update_welcome_text, 600);
});