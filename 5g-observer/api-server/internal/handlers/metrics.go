package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"

	"github.com/lpoclin/5g-observer/api-server/internal/prometheus"
)

type MetricsHandler struct {
	prom *prometheus.Client
}

func NewMetricsHandler(p *prometheus.Client) *MetricsHandler {
	return &MetricsHandler{prom: p}
}

// GET /api/metrics/cluster
func (h *MetricsHandler) GetClusterMetrics(c *gin.Context) {
	m, err := h.prom.ClusterMetrics(c.Request.Context())
	if err != nil {
		log.Warn().Err(err).Msg("cluster metrics")
		c.JSON(http.StatusOK, defaultClusterMetrics())
		return
	}
	c.JSON(http.StatusOK, m)
}

// GET /api/metrics/timeseries?range=1h
func (h *MetricsHandler) GetTimeSeries(c *gin.Context) {
	r := c.Query("range")
	if r == "" {
		r = "1h"
	}
	ts, err := h.prom.TimeSeries(c.Request.Context(), r)
	if err != nil {
		log.Warn().Err(err).Msg("timeseries")
		c.JSON(http.StatusOK, map[string]interface{}{
			"cpuPercent":    []interface{}{},
			"memoryPercent": []interface{}{},
		})
		return
	}
	c.JSON(http.StatusOK, ts)
}

// GET /api/metrics/pod/:namespace/:pod
func (h *MetricsHandler) GetPodMetrics(c *gin.Context) {
	ns := c.Param("namespace")
	pod := c.Param("pod")
	m, err := h.prom.PodMetrics(c.Request.Context(), ns, pod)
	if err != nil {
		log.Warn().Err(err).Msg("pod metrics")
		c.JSON(http.StatusOK, map[string]interface{}{"cpuPercent": 0, "memoryMi": 0})
		return
	}
	c.JSON(http.StatusOK, m)
}

// GET /api/metrics/interface?pod=PODNAME&interface=IFACE&nodeIP=NODE_IP
func (h *MetricsHandler) GetInterfaceMetrics(c *gin.Context) {
	iface  := c.Query("interface")
	nodeIP := c.Query("nodeIP")
	if iface == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "interface param required"})
		return
	}
	m, err := h.prom.InterfaceMetrics(c.Request.Context(), iface, nodeIP)
	if err != nil {
		log.Warn().Err(err).Str("iface", iface).Msg("interface metrics")
		c.JSON(http.StatusOK, map[string]interface{}{"throughputMbps": 0, "packetsPerSec": 0, "dropRate": 0})
		return
	}
	c.JSON(http.StatusOK, m)
}

func defaultClusterMetrics() map[string]interface{} {
	return map[string]interface{}{
		"cpuPercent": 0, "memoryPercent": 0,
		"podsRunning": 0, "podsTotal": 0,
		"nodesReady": 0, "nodesTotal": 0,
		"pvcsTotal": 0, "pvcsBound": 0,
	}
}
