# Marsad — everything runs in Docker. No host toolchain required.

COMPOSE := docker compose
GO      := $(COMPOSE) run --rm go
NODE    := $(COMPOSE) run --rm web

.DEFAULT_GOAL := help

## test: run all Go tests
.PHONY: test
test:
	$(GO) go test ./... $(ARGS)

## test-v: run all Go tests, verbose
.PHONY: test-v
test-v:
	$(GO) go test -v ./... $(ARGS)

## cover: run tests with a coverage summary
.PHONY: cover
cover:
	$(GO) sh -c 'go test -coverprofile=/tmp/c.out ./... && go tool cover -func=/tmp/c.out | tail -30'

## tidy: go mod tidy
.PHONY: tidy
tidy:
	$(GO) go mod tidy

## lint: golangci-lint
.PHONY: lint
lint:
	$(COMPOSE) run --rm lint golangci-lint run

## fmt: gofmt the tree
.PHONY: fmt
fmt:
	$(GO) gofmt -l -w .

## build: build the marsad binary into ./bin
.PHONY: build
build:
	$(GO) go build -o bin/marsad ./cmd/marsad

## sh: shell into the Go container
.PHONY: sh
sh:
	$(COMPOSE) run --rm go bash

## web-sh: shell into the Node container
.PHONY: web-sh
web-sh:
	$(COMPOSE) run --rm web bash

## clean: remove build output and caches
.PHONY: clean
clean:
	rm -rf bin
	$(COMPOSE) down -v

## help: list targets
.PHONY: help
help:
	@grep -hE '^## ' $(MAKEFILE_LIST) | sed 's/^## /  /' | sort
