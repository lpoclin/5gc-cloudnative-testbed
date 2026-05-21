package loki

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"time"
)

type Client struct {
	base string
	http *http.Client
}

func NewClient(baseURL string) *Client {
	return &Client{
		base: baseURL,
		http: &http.Client{Timeout: 30 * time.Second},
	}
}

// lokiQueryResponse is the Loki query_range API response
type lokiQueryResponse struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Stream map[string]string `json:"stream"`
			Values [][]string        `json:"values"` // [timestamp, line]
		} `json:"result"`
	} `json:"data"`
}

// QueryLast fetches the last N log lines for a pod
func (c *Client) QueryLast(ctx context.Context, namespace, pod string, limit int) ([]string, error) {
	query := fmt.Sprintf(`{namespace="%s"} |= "%s"`, namespace, pod)
	return c.queryRange(ctx, query, time.Now().Add(-24*time.Hour), time.Now(), limit)
}

// QueryRange fetches log lines between two timestamps
func (c *Client) QueryRange(ctx context.Context, namespace, pod string, start, end time.Time) ([]string, error) {
	query := fmt.Sprintf(`{namespace="%s"} |= "%s"`, namespace, pod)
	return c.queryRange(ctx, query, start, end, 200)
}

func (c *Client) queryRange(ctx context.Context, query string, start, end time.Time, limit int) ([]string, error) {
	params := url.Values{}
	params.Set("query", query)
	params.Set("start", strconv.FormatInt(start.UnixNano(), 10))
	params.Set("end",   strconv.FormatInt(end.UnixNano(), 10))
	params.Set("limit", strconv.Itoa(limit))
	params.Set("direction", "forward")

	reqURL := fmt.Sprintf("%s/loki/api/v1/query_range?%s", c.base, params.Encode())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("loki request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("loki %d: %s", resp.StatusCode, string(body))
	}

	var result lokiQueryResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("loki decode: %w", err)
	}

	// Flatten and sort all log lines by timestamp
	type entry struct {
		ts   int64
		line string
	}
	var entries []entry
	for _, stream := range result.Data.Result {
		for _, val := range stream.Values {
			if len(val) < 2 {
				continue
			}
			ts, _ := strconv.ParseInt(val[0], 10, 64)
			entries = append(entries, entry{ts: ts, line: val[1]})
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].ts < entries[j].ts })

	lines := make([]string, 0, len(entries))
	for _, e := range entries {
		lines = append(lines, e.line)
	}
	return lines, nil
}
