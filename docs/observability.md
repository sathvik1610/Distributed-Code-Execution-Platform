# Observability

## Prometheus

```text
http://localhost:9090
```

Prometheus scrapes:

- API Gateway metrics on `:9100`
- Execution Worker metrics on `:9101`
- System Monitor metrics on `:9102`

## Grafana

```text
http://localhost:3000
```

Default login: `admin` / `admin`

Grafana includes dashboards for:

- queue depth,
- job throughput,
- execution duration,
- WebSocket activity,
- DLQ count,
- worker recovery events,
- rate-limit hits.
