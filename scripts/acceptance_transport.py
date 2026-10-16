"""Private local acceptance identity over the real, certificate-checking management gateway."""

import ssl
from pathlib import Path

import httpx

from honeyforge.agent.identity import AgentIdentity


def enrolled_sync(url, ca, token, name, address, state):
    context = ssl.create_default_context(cafile=ca)
    current = httpx.Client(base_url=url + "/assets/sync/v1", verify=context, trust_env=False, timeout=15)
    enrolled = current.post(
        "/enroll",
        json={
            "token": token,
            "name": name,
            "address": address,
            "capabilities": ["http", "cowrie", "tcp-banner"],
        },
    )
    enrolled.raise_for_status()
    sensor = enrolled.json()
    current.headers["Authorization"] = "Bearer " + sensor["key"]
    identity = AgentIdentity(Path(state))

    def request(method, route, **kwargs):
        response = current.request(method, route.removeprefix("/agent/v1"), **kwargs)
        response.raise_for_status()
        return response.json()

    def install(certificate, key):
        nonlocal current
        trust = ssl.create_default_context(cafile=ca)
        trust.load_cert_chain(certificate, key)
        previous = current
        current = httpx.Client(
            base_url=url + "/assets/sync/v1",
            verify=trust,
            trust_env=False,
            timeout=15,
            headers={"Authorization": "Bearer " + sensor["key"]},
        )
        previous.close()

    identity.ensure(sensor["host_id"], request, install)
    return current, sensor
