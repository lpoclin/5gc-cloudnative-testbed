package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"

	"github.com/lpoclin/5g-observer/api-server/internal/capture"
)

// PacketsHandler streams decoded packets from the gRPC fan-out server to WebSocket.
type PacketsHandler struct {
	srv *capture.Server
}

func NewPacketsHandler(srv *capture.Server) *PacketsHandler {
	return &PacketsHandler{srv: srv}
}

// StreamPackets — GET /ws/packets/:node/:pod/:interface
func (h *PacketsHandler) StreamPackets(c *gin.Context) {
	node  := c.Param("node")
	pod   := c.Param("pod")
	iface := c.Param("interface")

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Error().Err(err).Msg("ws upgrade packets")
		return
	}
	defer conn.Close()

	key := capture.SessionKey{Node: node, PodName: pod, Iface: iface}
	ch, unsub := h.srv.RegisterSubscriber(key)
	defer unsub()

	log.Info().Str("node", node).Str("pod", pod).Str("iface", iface).Msg("packet ws stream started")

	// Drain client pings / close frames in a separate goroutine
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	type wirePacket struct {
		TimestampNs   int64  `json:"ts"`
		SrcIP         string `json:"src_ip"`
		DstIP         string `json:"dst_ip"`
		SrcPort       uint32 `json:"src_port"`
		DstPort       uint32 `json:"dst_port"`
		Protocol      string `json:"protocol"`
		Length        uint32 `json:"length"`
		Info          string `json:"info"`
		Raw           []byte `json:"raw,omitempty"`
		InterfaceName string `json:"iface"`
		PodName       string `json:"pod"`
		Namespace     string `json:"ns"`
		Node          string `json:"node"`
	}

	for {
		select {
		case <-done:
			return
		case pkts, ok := <-ch:
			if !ok {
				return
			}
			wire := make([]wirePacket, len(pkts))
			for i, p := range pkts {
				wire[i] = wirePacket{
					TimestampNs: p.TimestampNs, SrcIP: p.SrcIP, DstIP: p.DstIP,
					SrcPort: p.SrcPort, DstPort: p.DstPort, Protocol: p.Protocol,
					Length: p.Length, Info: p.Info, Raw: p.Raw,
					InterfaceName: p.InterfaceName, PodName: p.PodName,
					Namespace: p.Namespace, Node: p.Node,
				}
			}
			if err := conn.WriteJSON(map[string]interface{}{
				"type": "packets",
				"data": wire,
			}); err != nil {
				return
			}
		}
	}
}

// ExportCapture — GET /api/capture/export/:sessionID
func ExportCapture(c *gin.Context) {
	_ = c.Param("sessionID")
	c.JSON(http.StatusNotImplemented, gin.H{"error": "pcap export not yet implemented"})
}
