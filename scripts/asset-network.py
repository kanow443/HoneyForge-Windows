"""A dedicated management subnet/interface with a gateway-only egress namespace.

The agent stays outside this namespace so passive capture can see host trap bridges.
Only its TLS transport binds the management address. This is logical isolation;
a dedicated physical management NIC can replace the egress namespace in production.
"""
import ipaddress
import os
import socket
import subprocess
from urllib.parse import urlsplit

from honeyforge.infrastructure.settings import Settings


def call(*args, optional=False):
    result = subprocess.run(args, capture_output=True)
    if not optional:
        result.check_returncode()
    return result


def main():
    if os.geteuid() != 0:
        raise RuntimeError("Run on the dedicated Linux sensor as root")
    config = Settings(_env_file="/etc/asset-sync/agent.env")
    if config.agent_management_address != "10.88.0.1":
        raise ValueError("This installer reserves management address 10.88.0.1")
    gateway = urlsplit(config.agent_api)
    if gateway.scheme != "https":
        raise ValueError("Management requires verified HTTPS")
    address = str(ipaddress.IPv4Address(socket.gethostbyname(gateway.hostname)))
    port = str(gateway.port or 443)
    ns = "asset-management"
    if call("ip", "netns", "exec", ns, "true", optional=True).returncode:
        call("ip", "netns", "add", ns)
    for host, peer, host_ip, peer_ip in [("asmgmt0", "mgmt0", "10.88.0.1/30", "10.88.0.2/30"),
        ("asegress0", "egress0", "10.89.0.1/30", "10.89.0.2/30")]:
        if call("ip", "link", "show", host, optional=True).returncode:
            call("ip", "link", "add", host, "type", "veth", "peer", "name", peer)
            call("ip", "link", "set", peer, "netns", ns)
        call("ip", "addr", "replace", host_ip, "dev", host)
        call("ip", "link", "set", host, "up")
        call("ip", "netns", "exec", ns, "ip", "addr", "replace", peer_ip, "dev", peer)
        call("ip", "netns", "exec", ns, "ip", "link", "set", peer, "up")
    call("ip", "netns", "exec", ns, "sysctl", "-qw", "net.ipv4.ip_forward=1")
    call("ip", "netns", "exec", ns, "ip", "route", "replace", "default", "via", "10.89.0.1")
    call("ip", "netns", "exec", ns, "iptables", "-P", "FORWARD", "DROP")
    # Namespace is exclusively owned by this installer. No host/global chain is flushed.
    call("ip", "netns", "exec", ns, "iptables", "-F", "FORWARD")
    call("ip", "netns", "exec", ns, "iptables", "-A", "FORWARD", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT")
    call("ip", "netns", "exec", ns, "iptables", "-A", "FORWARD", "-i", "mgmt0", "-s", "10.88.0.1",
        "-d", address, "-p", "tcp", "--dport", port, "-j", "ACCEPT")
    call("ip", "netns", "exec", ns, "iptables", "-t", "nat", "-F", "POSTROUTING")
    call("ip", "netns", "exec", ns, "iptables", "-t", "nat", "-A", "POSTROUTING", "-o", "egress0", "-j", "MASQUERADE")
    for name in ["all", "asegress0", "asmgmt0"]:
        call("sysctl", "-qw", f"net.ipv4.conf.{name}.rp_filter=0")
    call("sysctl", "-qw", "net.ipv4.conf.asegress0.accept_local=1", "net.ipv4.ip_forward=1")
    call("iptables", "-w", "-N", "AS-MGMT", optional=True)
    call("iptables", "-w", "-F", "AS-MGMT")
    call("iptables", "-w", "-A", "AS-MGMT", "-o", "asegress0", "-d", "10.89.0.2", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT")
    call("iptables", "-w", "-A", "AS-MGMT", "-i", "asegress0", "-s", "10.89.0.2", "-d", address,
        "-p", "tcp", "--dport", port, "-j", "ACCEPT")
    call("iptables", "-w", "-A", "AS-MGMT", "-i", "asegress0", "-j", "DROP")
    if call("iptables", "-w", "-C", "FORWARD", "-j", "AS-MGMT", optional=True).returncode:
        call("iptables", "-w", "-I", "FORWARD", "1", "-j", "AS-MGMT")
    old_nat = ["-s", "10.88.0.1/32", "-d", address, "-p", "tcp", "--dport", port, "-j", "MASQUERADE"]
    call("iptables", "-w", "-t", "nat", "-D", "POSTROUTING", *old_nat, optional=True)
    nat = ["-s", "10.89.0.2/32", "-d", address, "-p", "tcp", "--dport", port, "-j", "MASQUERADE"]
    if call("iptables", "-w", "-t", "nat", "-C", "POSTROUTING", *nat, optional=True).returncode:
        call("iptables", "-w", "-t", "nat", "-A", "POSTROUTING", *nat)
    call("ip", "route", "replace", "table", "51820", "default", "via", "10.88.0.2", "dev", "asmgmt0")
    call("ip", "rule", "del", "priority", "11000", optional=True)
    call("ip", "rule", "add", "priority", "11000", "from", "10.88.0.1/32", "iif", "lo", "table", "51820")
    print("Management interface ready; only the configured HTTPS gateway is routable from its subnet.")


if __name__ == "__main__":
    main()
