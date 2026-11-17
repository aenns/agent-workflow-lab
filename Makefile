.PHONY: install dev-api dev-web test build

install:
	npm ci

dev-api:
	go run ./apps/api/cmd/api

dev-web:
	npm run dev

test:
	go test ./...

build:
	npm run build
	go build ./...

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
