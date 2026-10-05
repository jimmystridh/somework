"""Drives a SomeWork A2A gateway with the official `a2a-sdk` client (HTTP+JSON binding).

usage: interop.py <base_url> <token> <scenario> [skill_id]
Prints one JSON document on stdout describing what the SDK observed.
"""
import asyncio
import json
import sys

import httpx
from google.protobuf.json_format import MessageToDict

from a2a.client import ClientConfig, ClientFactory
from a2a.client.card_resolver import A2ACardResolver
from a2a.types.a2a_pb2 import (
    GetTaskRequest,
    Message,
    Part,
    Role,
    SendMessageConfiguration,
    SendMessageRequest,
)


def invocation(skill_id: str, payload: dict, message_id: str) -> SendMessageRequest:
    part = Part()
    part.data.struct_value.update({"skillId": skill_id, "input": payload})
    message = Message(message_id=message_id, role=Role.ROLE_USER, parts=[part])
    return SendMessageRequest(message=message, configuration=SendMessageConfiguration(return_immediately=False))


async def main() -> None:
    base_url, token, scenario = sys.argv[1], sys.argv[2], sys.argv[3]
    skill = sys.argv[4] if len(sys.argv) > 4 else "ops.diagnose"
    out: dict = {"scenario": scenario}
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(headers=headers, timeout=60) as http:
        if scenario == "bad-version":
            r = await http.post(f"{base_url}/a2a/message:send", headers={"A2A-Version": "0.2"}, json={})
            out["status"] = r.status_code
            out["body"] = r.json()
            print(json.dumps(out))
            return

        resolver = A2ACardResolver(http, base_url)
        card = await resolver.get_agent_card()
        out["card"] = MessageToDict(card)

        streaming = scenario == "stream"
        factory = ClientFactory(ClientConfig(httpx_client=http, streaming=streaming, supported_protocol_bindings=["HTTP+JSON"]))
        client = factory.create(card)
        events = []
        try:
            async for ev in client.send_message(invocation(skill, {"repository": "billing/import-service", "commit": "61a8d52"}, f"msg-{scenario}-{skill}")):
                events.append(MessageToDict(ev))
        except Exception as e:  # the SDK maps A2A error reasons onto exception types
            out["error"] = {"type": type(e).__name__, "message": str(e)}
            print(json.dumps(out))
            return
        out["events"] = events
        last_task = next((e["task"] for e in reversed(events) if "task" in e), None)
        if last_task is None:
            ids = [e.get("statusUpdate", {}).get("taskId") for e in events if "statusUpdate" in e]
            last_task_id = ids[-1] if ids else None
        else:
            last_task_id = last_task["id"]
        if last_task_id:
            fetched = await client.get_task(GetTaskRequest(id=last_task_id))
            out["task"] = MessageToDict(fetched)
    print(json.dumps(out))


asyncio.run(main())
