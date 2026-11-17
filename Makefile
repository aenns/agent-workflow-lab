.PHONY: install install-py dev-api dev-web test test-integration build

PYTHON ?= python3
PY_API = apps/api-py

install:
	npm ci

install-py:
	$(PYTHON) -m venv $(PY_API)/.venv
	$(PY_API)/.venv/bin/python -m pip install -r $(PY_API)/requirements.txt

dev-api:
	go run ./apps/api/cmd/api

dev-web:
	npm run dev

test:
	go test ./apps/api/...
	npm test --workspace apps/api-ts
	npm test --workspace apps/web
	cd $(PY_API) && .venv/bin/python -m unittest discover -s tests

test-integration:
	$(PYTHON) tests/integration.py

build:
	npm run build
	go build ./apps/api/...
	cd $(PY_API) && .venv/bin/python -m compileall -q workflow_lab

.PHONY: dev-db stop-db
dev-db:
	docker compose up -d --wait postgres

stop-db:
	docker compose stop postgres

.PHONY: dev-temporal dev-worker stop-temporal
dev-temporal:
	docker compose up -d --wait temporal

dev-worker:
	go run ./apps/api/cmd/api temporal-worker

stop-temporal:
	docker compose stop temporal

.PHONY: generate-api
generate-api:
	go generate ./apps/api/internal/httpapi/contract

.PHONY: dev-api-ts dev-worker-ts
dev-api-ts:
	npm run dev --workspace apps/api-ts

dev-worker-ts:
	npm run worker --workspace apps/api-ts

.PHONY: dev-api-py dev-worker-py
dev-api-py:
	cd $(PY_API) && .venv/bin/python -m workflow_lab.server

dev-worker-py:
	cd $(PY_API) && .venv/bin/python -m workflow_lab.worker
