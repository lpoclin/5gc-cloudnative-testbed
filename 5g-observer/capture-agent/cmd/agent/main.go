package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/lpoclin/5g-observer/capture-agent/internal/discovery"
	"github.com/lpoclin/5g-observer/capture-agent/internal/capture"
	agentgrpc "github.com/lpoclin/5g-observer/capture-agent/internal/grpc"
)

func main() {
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339})
	zerolog.SetGlobalLevel(zerolog.InfoLevel)

	apiServerAddr := envOr("API_SERVER_ADDR", "5g-observer-api:9999")
	targetNS      := envOr("TARGET_NAMESPACES", "free5gc")
	nodeNameStr   := envOr("NODE_NAME", "")

	log.Info().
		Str("apiServer", apiServerAddr).
		Str("namespaces", targetNS).
		Str("node", nodeNameStr).
		Msg("capture-agent starting")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// ── gRPC client to api-server ────────────────────────────────────────────
	grpcClient, err := agentgrpc.NewClient(apiServerAddr)
	if err != nil {
		log.Fatal().Err(err).Msg("grpc client init failed")
	}
	defer grpcClient.Close()

	// ── Pod discovery loop ───────────────────────────────────────────────────
	disc, err := discovery.NewDiscovery(splitNS(targetNS), nodeNameStr)
	if err != nil {
		log.Fatal().Err(err).Msg("discovery init failed")
	}

	// ── Capture manager ──────────────────────────────────────────────────────
	capMgr := capture.NewManager(grpcClient)

	go disc.Run(ctx, func(pods []discovery.PodInfo) {
		capMgr.Reconcile(ctx, pods)
	})

	// ── Graceful shutdown ────────────────────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Info().Msg("shutting down capture-agent")
	cancel()
	capMgr.StopAll()
	log.Info().Msg("goodbye")
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func splitNS(s string) []string {
	var out []string
	cur := ""
	for _, c := range s {
		if c == ',' {
			if cur != "" {
				out = append(out, cur)
				cur = ""
			}
		} else {
			cur += string(c)
		}
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}
