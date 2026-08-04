# Marsad — everything runs in Docker. No host toolchain required.

COMPOSE := docker compose
GO      := $(COMPOSE) run --rm go
DEV     := $(COMPOSE) run --rm --service-ports dev
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

## dev: run the backend against your current kubeconfig on :8080
.PHONY: dev
dev:
	$(DEV) go run ./cmd/marsad -log-level=debug $(ARGS)

## dev-shell: shell into the cluster-capable dev container
.PHONY: dev-shell
dev-shell:
	$(COMPOSE) run --rm dev bash

KIND_CLUSTER ?= marsad

## kind-up: create a local kind cluster with the AWS CRD and the example policies
.PHONY: kind-up
kind-up:
	kind get clusters 2>/dev/null | grep -qx '$(KIND_CLUSTER)' || kind create cluster --name '$(KIND_CLUSTER)' --wait 90s
	kubectl --context 'kind-$(KIND_CLUSTER)' apply -f deploy/crds/
	kubectl --context 'kind-$(KIND_CLUSTER)' apply -f examples/
	kind get kubeconfig --name '$(KIND_CLUSTER)' --internal > .kube-kind.yaml
	@echo
	@echo "kind cluster '$(KIND_CLUSTER)' ready. Run: make dev-kind"

## dev-kind: run the backend against the local kind cluster on :8080
.PHONY: dev-kind
dev-kind: .kube-kind.yaml
	$(COMPOSE) run --rm --service-ports kind go run ./cmd/marsad -log-level=debug $(ARGS)

.kube-kind.yaml:
	kind get kubeconfig --name '$(KIND_CLUSTER)' --internal > $@

## kind-down: delete the local kind cluster
.PHONY: kind-down
kind-down:
	kind delete cluster --name '$(KIND_CLUSTER)'
	rm -f .kube-kind.yaml

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
