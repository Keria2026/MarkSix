FROM rust:1.90-bookworm AS build
WORKDIR /app
# .dockerignore allowlists only the manifest, source and migrations. A single
# copy also avoids duplicating the large toolchain layer on VFS builders.
COPY . .
ARG CARGO_BUILD_JOBS=2
ARG MARKSIX_REVISION=development
ENV MARKSIX_REVISION=${MARKSIX_REVISION}
RUN --mount=type=secret,id=build_ca --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/app/target if [ -f /run/secrets/build_ca ]; then export CARGO_HTTP_CAINFO=/run/secrets/build_ca; fi; cargo build --release --locked --bin marksix && cp /app/target/release/marksix /marksix

FROM debian:bookworm-slim
COPY --chmod=644 --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --chmod=755 --from=build /marksix /usr/local/bin/marksix
USER 10001:10001
ENV BIND_ADDR=0.0.0.0:8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD ["marksix", "--hosted-healthcheck"]
CMD ["marksix", "--hosted"]
