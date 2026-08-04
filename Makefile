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

IMAGE    ?= marsad
TAG      ?= dev
PLATFORM ?= linux/amd64

# Registry repo to push to, e.g. 123456789012.dkr.ecr.eu-west-2.amazonaws.com/marsad
REGISTRY     ?=
KUBE_CONTEXT ?= $(shell kubectl config current-context 2>/dev/null)
# Deploy by commit rather than by a floating tag, so a rollout is traceable to a
# revision and so imagePullPolicy never serves a stale layer.
GIT_SHA      := $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)

KIND_CLUSTER ?= marsad

## image: build the container image ($(IMAGE):$(TAG), PLATFORM=$(PLATFORM))
.PHONY: image
image:
	docker build --platform '$(PLATFORM)' --build-arg VERSION='$(TAG)' -t '$(IMAGE):$(TAG)' .

## kind-deploy: build, load and deploy into the local kind cluster
.PHONY: kind-deploy
kind-deploy:
	$(MAKE) image PLATFORM=linux/$(shell uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
	kind load docker-image '$(IMAGE):$(TAG)' --name '$(KIND_CLUSTER)'
	kubectl --context 'kind-$(KIND_CLUSTER)' apply -f deploy/marsad.yaml -f deploy/rbac.yaml
	kubectl --context 'kind-$(KIND_CLUSTER)' -n marsad rollout restart deploy/marsad
	kubectl --context 'kind-$(KIND_CLUSTER)' -n marsad rollout status deploy/marsad --timeout=120s
	@echo
	@echo "kubectl --context kind-$(KIND_CLUSTER) -n marsad port-forward svc/marsad 8080:80"

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

## push: build the amd64 image and push it to $(REGISTRY)
.PHONY: push
push: require-registry
	docker build --platform linux/amd64 --build-arg VERSION='$(GIT_SHA)' \
		-t '$(REGISTRY):$(GIT_SHA)' .
	docker push '$(REGISTRY):$(GIT_SHA)'

## deploy: apply the manifests to $(KUBE_CONTEXT) using the pushed image
.PHONY: deploy
deploy: require-registry
	@echo "deploying $(REGISTRY):$(GIT_SHA) to $(KUBE_CONTEXT)"
	@sed 's|image: marsad:dev|image: $(REGISTRY):$(GIT_SHA)|' deploy/marsad.yaml \
		| kubectl --context '$(KUBE_CONTEXT)' apply -f -
	kubectl --context '$(KUBE_CONTEXT)' apply -f deploy/rbac.yaml
	kubectl --context '$(KUBE_CONTEXT)' -n marsad rollout status deploy/marsad --timeout=180s
	@echo
	@echo "kubectl --context '$(KUBE_CONTEXT)' -n marsad port-forward svc/marsad 8080:80"

## undeploy: remove Marsad from $(KUBE_CONTEXT)
.PHONY: undeploy
undeploy:
	kubectl --context '$(KUBE_CONTEXT)' delete -f deploy/rbac.yaml --ignore-not-found
	kubectl --context '$(KUBE_CONTEXT)' delete -f deploy/marsad.yaml --ignore-not-found

.PHONY: require-registry
require-registry:
	@test -n "$(REGISTRY)" || { \
		echo "set REGISTRY, e.g. make deploy REGISTRY=123456789012.dkr.ecr.eu-west-2.amazonaws.com/marsad"; \
		exit 1; }

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
