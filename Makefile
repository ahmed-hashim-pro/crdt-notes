# Thin wrappers over npm, plus the targets that regenerate what the README shows.
.PHONY: install test fuzz mutants build start e2e demo check

install:
	npm ci

test:
	npm run typecheck
	npm test

# The convergence claim at full size: 5,000 hostile seeds, then every
# deliberate bug against 2,000 seeds.
fuzz:
	npm run fuzz -- hunt --seeds 5000

mutants:
	npm run fuzz -- mutants --seeds 2000

build:
	npm run build

start: build
	npm start

e2e: build
	npm run e2e

check: test fuzz mutants build e2e

# Re-record docs/converge.gif from the end-to-end test. CHROME=1 uses an
# installed Google Chrome instead of Playwright's Chromium.
demo: build
	rm -rf e2e/frames
	cd e2e && RECORD=1 npx playwright test -g "two replicas"
	python3 e2e/make-gif.py
