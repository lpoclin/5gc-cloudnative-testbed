package handlers

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/rs/zerolog/log"
	"k8s.io/client-go/kubernetes"

	k8stopo "github.com/lpoclin/5g-observer/api-server/internal/k8s"
)

var upgrader = websocket.Upgrader{
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  1024,
	WriteBufferSize: 32 * 1024,
}

type TopologyHandler struct {
	cs *kubernetes.Clientset
}

func NewTopologyHandler(cs *kubernetes.Clientset) *TopologyHandler {
	return &TopologyHandler{cs: cs}
}

// GET /api/topology?namespace=free5gc[,other]
func (h *TopologyHandler) GetTopology(c *gin.Context) {
	ns := c.Query("namespace")
	if ns == "" {
		ns = "free5gc"
	}
	namespaces := strings.Split(ns, ",")

	graph, err := k8stopo.BuildTopology(c.Request.Context(), h.cs, namespaces)
	if err != nil {
		log.Error().Err(err).Msg("build topology")
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, graph)
}

// GET /api/namespaces
func (h *TopologyHandler) GetNamespaces(c *gin.Context) {
	nsList, err := h.cs.CoreV1().Namespaces().List(c.Request.Context(), listOpts())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	names := make([]string, 0, len(nsList.Items))
	for _, ns := range nsList.Items {
		names = append(names, ns.Name)
	}
	c.JSON(http.StatusOK, names)
}

// GET /api/pods/:namespace
func (h *TopologyHandler) GetPods(c *gin.Context) {
	ns := c.Param("namespace")
	graph, err := k8stopo.BuildTopology(c.Request.Context(), h.cs, []string{ns})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, graph.Nodes)
}

// GET /api/pod/:namespace/:pod/interfaces
func (h *TopologyHandler) GetPodInterfaces(c *gin.Context) {
	ns := c.Param("namespace")
	podName := c.Param("pod")

	pod, err := h.cs.CoreV1().Pods(ns).Get(c.Request.Context(), podName, getOpts())
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	node := k8stopo.PodToNodeExported(pod)
	if node == nil {
		c.JSON(http.StatusOK, []interface{}{})
		return
	}
	c.JSON(http.StatusOK, node.Interfaces)
}

// GET /ws/topology?namespace=free5gc  — push updates every 5s
func (h *TopologyHandler) WatchTopology(c *gin.Context) {
	ns := c.Query("namespace")
	if ns == "" {
		ns = "free5gc"
	}
	namespaces := strings.Split(ns, ",")

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Error().Err(err).Msg("ws upgrade")
		return
	}
	defer conn.Close()

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	// Send immediately on connect
	sendTopology(conn, h.cs, namespaces)

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			sendTopology(conn, h.cs, namespaces)
		}
	}
}

func sendTopology(conn *websocket.Conn, cs *kubernetes.Clientset, namespaces []string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	graph, err := k8stopo.BuildTopology(ctx, cs, namespaces)
	if err != nil {
		log.Error().Err(err).Msg("topology watch")
		return
	}

	type envelope struct {
		Type string      `json:"type"`
		Data interface{} `json:"data"`
	}
	if err := conn.WriteJSON(envelope{Type: "topology", Data: graph}); err != nil {
		log.Debug().Err(err).Msg("topology ws write")
	}
}
