FROM rust:1.90-bookworm AS dependencies
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
ARG CARGO_BUILD_JOBS=2
# Keep dependencies in an ordinary image layer: remote BuildKit layer caches
# do not export cache mounts, and the revision changes on every CI build.
RUN mkdir src && printf 'fn main() {}\n' > src/main.rs && touch src/lib.rs
RUN --mount=type=secret,id=build_ca if [ -f /run/secrets/build_ca ]; then export CARGO_HTTP_CAINFO=/run/secrets/build_ca; fi; cargo build --release --locked --bin marksix && rm -rf src target/release/.fingerprint/marksix-* target/release/deps/marksix-* target/release/marksix target/release/libmarksix*

FROM dependencies AS build
COPY . .
ARG MARKSIX_REVISION=development
ENV MARKSIX_REVISION=${MARKSIX_REVISION}
RUN --mount=type=secret,id=build_ca if [ -f /run/secrets/build_ca ]; then export CARGO_HTTP_CAINFO=/run/secrets/build_ca; fi; cargo build --release --locked --bin marksix && cp /app/target/release/marksix /marksix

FROM debian:bookworm-slim
COPY --chmod=644 --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --chmod=755 --from=build /marksix /usr/local/bin/marksix
USER 10001:10001
ENV BIND_ADDR=0.0.0.0:8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD ["marksix", "--hosted-healthcheck"]
CMD ["marksix", "--hosted"]
