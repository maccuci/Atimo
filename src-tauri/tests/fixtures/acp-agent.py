#!/usr/bin/env python3
"""An ACP peer for offline tests; never calls a provider or reads credentials."""
import json
import sys
import time

authenticated = False
pending_prompt = None


def send(message):
    print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)


for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    request_id = message["id"]
    result = {}
    if method == "initialize":
        assert message["params"]["clientCapabilities"]["terminal"] is False
        result = {"protocolVersion": 1, "authMethods": [{"id": "cached_token"}]}
    elif method == "authenticate":
        assert message["params"]["methodId"] == "cached_token"
        authenticated = True
    elif method == "session/new":
        if not authenticated:
            send({"id": request_id, "error": {"code": -32000, "message": "Authentication required"}})
            continue
        result = {"sessionId": "test-session", "configOptions": [{
            "id": "model", "category": "model", "currentValue": "test-model",
            "options": [{"group": "Test", "options": [{"value": "test-model", "name": "Test Model"}]}],
        }]}
    elif method == "session/prompt":
        pending_prompt = request_id
        send({"id": "permission", "method": "session/request_permission", "params": {}})
        continue
    elif method == "test/hang":
        time.sleep(60)
        continue
    elif request_id == "permission":
        assert message["result"]["outcome"]["outcome"] == "cancelled"
        send({"id": "file", "method": "fs/read_text_file", "params": {"path": "/private.txt"}})
        continue
    elif request_id == "file":
        assert message["error"]["code"] == -32601
        for kind, text in [("agent_thought_chunk", "Thinking"), ("agent_message_chunk", "Hello")]:
            send({"method": "session/update", "params": {"update": {
                "sessionUpdate": kind, "content": {"type": "text", "text": text},
            }}})
        send({"id": pending_prompt, "result": {"stopReason": "end_turn"}})
        continue
    send({"id": request_id, "result": result})
