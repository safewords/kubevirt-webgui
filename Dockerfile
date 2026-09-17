# syntax=docker/dockerfile:1.7

# --- the browser app ---------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/ ./
RUN npm run build

# --- the server --------------------------------------------------------------
FROM rust:1-bookworm AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY --from=web /web/dist ./web/dist
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/kubevirt-webgui /kubevirt-webgui

# --- runtime -----------------------------------------------------------------
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=server /kubevirt-webgui /usr/local/bin/kubevirt-webgui
WORKDIR /app
ENV APP_ENV=production \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=8006 \
    RUST_LOG=info
EXPOSE 8006
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/kubevirt-webgui"]
CMD ["serve"]
