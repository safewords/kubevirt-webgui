# syntax=docker/dockerfile:1.7

# Local builds: `docker build .` compiles the browser app and the server from source.
# CI builds: `docker buildx build --target prebuilt` packages binaries from dist/<arch>/.

# --- the browser app ---------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/ ./
RUN npm run build

# --- the server --------------------------------------------------------------
# The built app is copied in before `cargo build`: rust-embed compiles web/dist
# into the binary for release builds, so the order is not incidental.
FROM rust:1-trixie AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock rustfmt.toml ./
COPY src ./src
COPY --from=web /web/dist ./web/dist
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/kubevirt-webgui /kubevirt-webgui

# --- runtime -----------------------------------------------------------------
# debian13 (trixie), not debian12: CI builds the binaries on the GitHub runner
# and copies them in, so the base's glibc must be no older than the runner's.
FROM gcr.io/distroless/cc-debian13:nonroot AS runtime
WORKDIR /app
ENV APP_ENV=production \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=8006 \
    RUST_LOG=info
EXPOSE 8006
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/kubevirt-webgui"]
CMD ["serve"]

# --- CI: package the binary built on a native runner -------------------------
FROM runtime AS prebuilt
ARG TARGETARCH
COPY dist/${TARGETARCH}/kubevirt-webgui /usr/local/bin/kubevirt-webgui

# --- the default: everything from source -------------------------------------
FROM runtime
COPY --from=server /kubevirt-webgui /usr/local/bin/kubevirt-webgui
