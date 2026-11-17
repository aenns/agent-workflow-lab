.PHONY: install dev-api dev-web test build

install:
	npm ci

dev-api:
	go run ./apps/api/cmd/api

dev-web:
	npm run dev

test:
	go test ./apps/api/...
	npm test --workspace apps/api-ts

build:
	npm run build
	go build ./apps/api/...

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
