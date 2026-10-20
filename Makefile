# The suite's meta commands. Each target calls lefthook or a script in tools/; nothing is
# implemented here, so `make` and the scripts never disagree.

.DEFAULT_GOAL := help
.PHONY: help hooks test check e2e e2e-skill e2e-fence package install

PART    ?=# install, control or skills; empty: all
SKILL   ?=# a skill's folder name under packages/skills
STORAGE ?=# AnythingLLM's storage folder; empty: AnythingLLM Desktop's

help: ## List the commands
	@awk -F':.*## ' '/^[a-z0-9-]+:.*## /{printf "  make %-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

hooks: ## Install the git hooks, once per clone
	@command -v lefthook >/dev/null || { \
		printf '%s\n' "lefthook is not installed. Install it with one of:" \
			"  uv tool install lefthook" \
			"  brew install lefthook" \
			"  npm install --global lefthook" \
			"then run: make hooks" >&2; \
		exit 1; }
	lefthook install

test: ## Run the push hooks on every file (each part's tests)
	lefthook run pre-push --all-files

check: ## Test a part (PART=control) or, with no PART, all of them
	tools/check $(PART)

e2e: ## Install into a throwaway AnythingLLM and run the suite against it (needs podman or docker)
	tools/e2e

e2e-skill: ## Run a skill's own check inside a throwaway AnythingLLM (SKILL=browser; empty: every skill that has one)
	tools/e2e-skill $(SKILL)

e2e-fence: ## Check the fence's asks against a real anywherellm-bridge checkout (BRIDGE=<folder>; empty: ../anywherellm-bridge)
	tools/e2e-fence $(BRIDGE)

package: ## Build and zip a skill into dist/ (SKILL=library)
	tools/package $(SKILL)

install: ## Build and install into AnythingLLM's storage (STORAGE=<folder>; empty: Desktop's)
	tools/install $(if $(STORAGE),--storage "$(STORAGE)")
