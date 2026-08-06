# Marsad ships as a single static binary with the UI embedded in it, so deploying
# is one image with no sidecar and no static-asset bucket.

# The frontend builds first and in its own stage. It changes far less often than
# the Go code, so a backend edit does not reinstall node_modules.
#
# Pinned to $BUILDPLATFORM because the output is JavaScript — identical whatever
# the target architecture. Without this a multi-arch build runs the whole npm
# install and Vite build again under QEMU for each extra platform, to produce
# byte-identical files.
FROM --platform=$BUILDPLATFORM node:22-bookworm AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --platform=$BUILDPLATFORM keeps the toolchain native to the build machine and
# lets Go cross-compile to the target. Building an amd64 image on an arm64 Mac
# therefore costs nothing; emulating an amd64 toolchain under QEMU would be
# minutes slower for an identical result.
FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS build
WORKDIR /src

# Dependencies in their own layer: they change far less often than the code.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# The repo carries a placeholder page so `go build` works without node. Replace
# it wholesale rather than merging, so a renamed asset cannot leave a stale file
# embedded in the binary.
RUN rm -rf internal/server/assets && mkdir -p internal/server/assets
COPY --from=web /web/dist/ internal/server/assets/

ARG VERSION=dev
ARG TARGETOS
ARG TARGETARCH
# Static and stripped: distroless has no libc to link against, and debug
# information is dead weight in an image whose only job is to run one binary.
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build \
        -trimpath \
        -ldflags "-s -w -X main.version=${VERSION}" \
        -o /out/marsad ./cmd/marsad

# Distroless: no shell, no package manager, nothing to pivot to. A read-only
# dashboard has no business carrying a userland.
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/marsad /marsad

USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/marsad"]
