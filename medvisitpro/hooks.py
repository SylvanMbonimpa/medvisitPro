app_name = "medvisitpro"
app_title = "Med visit Pro"
app_publisher = "Sylvain"
app_description = "Visit Management"
app_email = "mbonimpasylvain@gmail.com"
app_license = "mit"

get_website_user_home_page = "medvisitpro.auth.get_home_page"
app_include_js = "/assets/medvisitpro/js/medvisitpro_common.js"
scheduler_events = {
    "daily": [
        "medvisitpro.tasks.mark_missed_visits",
    ]
}

doc_events = {
    "Customer": {
        "before_insert": [
            "medvisitpro.customer_hooks.assign_client_id",
        ],
        "validate": [
            "medvisitpro.customer_hooks.enforce_registered_location_lock",
            "medvisitpro.customer_hooks.set_expected_visits_from_class",
        ],
    },
    "User": {
        "validate": [
            "medvisitpro.user_hooks.enforce_manager_role_bundle",
            "medvisitpro.user_hooks.enforce_secondary_territory",
        ],
    },
}