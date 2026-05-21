FROM golang:1.26-alpine AS builder
WORKDIR /app
RUN apk add --no-cache git ca-certificates
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w" -o /api-server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /api-server /api-server
EXPOSE 8080
ENTRYPOINT ["/api-server"]
