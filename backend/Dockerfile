FROM rust:1.90-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations
RUN --mount=type=secret,id=build_ca if [ -f /run/secrets/build_ca ]; then export CARGO_HTTP_CAINFO=/run/secrets/build_ca; fi; cargo build --release --locked --bin marksix

FROM debian:bookworm-slim
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /app/target/release/marksix /usr/local/bin/marksix
USER 10001:10001
ENV BIND_ADDR=0.0.0.0:8080 RUST_LOG=marksix=info,tower_http=info
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD ["marksix", "--healthcheck"]
CMD ["marksix"]
