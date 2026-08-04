# Dev image for running Marsad against a real cluster.
#
# Kept separate from the plain golang image used by `make test` so the test loop
# stays fast and does not depend on this ever being rebuilt.
#
# The AWS CLI is here because kubeconfigs for EKS authenticate through an exec
# credential plugin (`aws eks get-token`). That binary runs wherever the client
# runs, so it has to exist inside the container — mounting ~/.aws alone is not
# enough. Nothing else is added: Marsad talks to the API server directly and
# never shells out to kubectl.
FROM golang:1.24-bookworm

ARG AWSCLI_VERSION=2.27.25

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip less \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        arm64) awsarch=aarch64 ;; \
        amd64) awsarch=x86_64 ;; \
        *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${awsarch}-${AWSCLI_VERSION}.zip" -o /tmp/awscli.zip; \
    unzip -q /tmp/awscli.zip -d /tmp; \
    /tmp/aws/install; \
    rm -rf /tmp/awscli.zip /tmp/aws; \
    aws --version

WORKDIR /src
