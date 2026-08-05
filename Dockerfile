# Marsad ships as a single static binary with the UI embedded in it.
#
# There is no frontend build stage yet: until step 3 lands, the binary embeds the
# placeholder page checked in at internal/server/assets. When web/ exists, a
# node stage builds it and writes into that directory before the Go build.
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
