# API Reference

The default local API key in Docker Compose is `test-api-key`.

## Endpoints

| Method | Path | Description | Auth |
|---|---|---|---|
| `GET` | `/health` | Health check | No |
| `POST` | `/submissions` | Submit code | Yes |
| `GET` | `/submissions/:id` | Fetch one result | Yes |
| `GET` | `/submissions?page=1&limit=10&status=COMPLETED` | List submissions | Yes |
| `GET` | `/stream/:jobId` | WebSocket output stream | Yes |
| `GET` | `/dlq` | Inspect dead-letter jobs | Yes |
| `DELETE` | `/dlq/:jobId` | Remove a dead-letter job | Yes |

## Submit Python Code

```bash
curl -X POST http://localhost:8000/submissions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-api-key" \
  -d '{
    "language": "python",
    "code": "print([x * 2 for x in range(5)])"
  }'
```

Response:

```json
{
  "jobId": "uuid",
  "status": "PENDING"
}
```

## Fetch Result

```bash
curl -H "X-API-Key: test-api-key" \
  http://localhost:8000/submissions/<jobId>
```

## Run A Local File

```bash
node run-file.js sample.py
node run-file.js sample.js
```

## WebSocket Stream

Connect to:

```text
ws://localhost:8000/stream/<jobId>
```

The WebSocket must include:

```text
X-API-Key: test-api-key
```
