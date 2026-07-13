<<<<<<< HEAD
### Medical Visit Software

This is for Surgipharm
=======
### MedVisitPro

This app is for Surgipharm Pharmacy which allow Agent visiting their customers and explain about the new product. theapp track physical location of a delegate while filling the form
>>>>>>> 01cc2d76173e88811d5df123f1bb8cf108643ffb

### Installation

You can install this app using the [bench](https://github.com/frappe/bench) CLI:

```bash
cd $PATH_TO_YOUR_BENCH
<<<<<<< HEAD
bench get-app $URL_OF_THIS_REPO --branch MedvisitPr
=======
bench get-app $URL_OF_THIS_REPO --branch MedVisitPro
>>>>>>> 01cc2d76173e88811d5df123f1bb8cf108643ffb
bench install-app medvisitpro
```

### Contributing

This app uses `pre-commit` for code formatting and linting. Please [install pre-commit](https://pre-commit.com/#installation) and enable it for this repository:

```bash
cd apps/medvisitpro
pre-commit install
```

Pre-commit is configured to use the following tools for checking and formatting your code:

- ruff
- eslint
- prettier
- pyupgrade
### CI

This app can use GitHub Actions for CI. The following workflows are configured:

- CI: Installs this app and runs unit tests on every push to `develop` branch.
- Linters: Runs [Frappe Semgrep Rules](https://github.com/frappe/semgrep-rules) and [pip-audit](https://pypi.org/project/pip-audit/) on every pull request.


### License

mit
<<<<<<< HEAD
=======
# medvisitPro
>>>>>>> 01cc2d76173e88811d5df123f1bb8cf108643ffb
